'use strict';

const crypto = require('crypto');
const { TprmError } = require('./errors');

const PORTAL_PATH = '/vendor/p/';
const COOKIE = 'tpv_sid';
const LIMITS = Object.freeze({
  codeMinutes: 10,
  codeAttempts: 5,
  codesPerEmailWindowMinutes: 15,
  codesPerEmail: 4,
  sessionHours: 12,
  idleMinutes: 120,
});
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const normEmail = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function peopleForEmail(db, email, { firmId = null, personId = null } = {}) {
  const rows = await db.prepare(`SELECT p.id, p.workspace_id, p.third_party_id, p.email, p.name, p.job_title, p.phone, p.role, p.row_version,
      t.name AS third_party_name, w.firm_id, COALESCE(w.brand_display_name, w.client_name) AS client_name
    FROM tp_vendor_people p
    JOIN tp_third_parties t ON t.workspace_id = p.workspace_id AND t.id = p.third_party_id
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN tp_client_settings s ON s.workspace_id = p.workspace_id AND s.enabled
    WHERE p.email = ? AND p.status = 'active' AND t.status <> 'exited'${firmId ? ' AND w.firm_id = ?' : ''}${personId ? ' AND p.id = ?' : ''}
    ORDER BY lower(COALESCE(w.brand_display_name, w.client_name)), lower(t.name), p.id`)
    .all(...[email, ...(firmId ? [firmId] : []), ...(personId ? [personId] : [])]);
  return rows.map(r => ({ ...r, id: Number(r.id), workspace_id: Number(r.workspace_id), third_party_id: Number(r.third_party_id), firm_id: Number(r.firm_id) }));
}

async function linkRecipients(db, email, { firmId = null } = {}) {
  const rows = await db.prepare(`SELECT DISTINCT ON (r.workspace_id, a.third_party_id) r.workspace_id, a.third_party_id, r.recipient_name, w.firm_id
    FROM tp_vendor_requests r
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id AND a.status <> 'cancelled'
    JOIN workspaces w ON w.id = r.workspace_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id AND t.status <> 'exited'
    JOIN tp_client_settings s ON s.workspace_id = r.workspace_id AND s.enabled
    WHERE lower(trim(r.recipient_email)) = ? AND r.status IN ('active', 'submitted') AND r.expires_at > now()
      AND NOT ${require('./link-access').recipientLeft('r', 'a.third_party_id')}${firmId ? ' AND w.firm_id = ?' : ''}
    ORDER BY r.workspace_id, a.third_party_id, r.created_at DESC`).all(...[email, ...(firmId ? [firmId] : [])]);
  return rows.map(r => ({ workspaceId: Number(r.workspace_id), thirdPartyId: Number(r.third_party_id), name: r.recipient_name, firmId: Number(r.firm_id) }));
}

async function ensureLinkPeople(db, email, firmId) {
  const vendorPeople = require('./vendor-people');
  for (const r of await linkRecipients(db, email, { firmId })) {
    await vendorPeople.forLinkRecipient(db, { workspaceId: r.workspaceId, thirdPartyId: r.thirdPartyId, email, name: r.name });
  }
}

async function firmsFor(db, email) {
  const people = [...await peopleForEmail(db, email), ...(await linkRecipients(db, email)).map(r => ({ firm_id: r.firmId }))];
  const firms = new Map();
  for (const p of people) if (!firms.has(p.firm_id)) firms.set(p.firm_id, p.firm_id);
  if (!firms.size) return [];
  const ids = [...firms.keys()];
  const rows = await db.prepare(`SELECT f.id, f.name FROM firms f WHERE f.id IN (${ids.map(() => '?').join(',')}) ORDER BY lower(f.name)`).all(...ids);
  const letterhead = require('./letterhead');
  const out = [];
  for (const r of rows) {
    const lh = await letterhead.getLetterhead(db, r.id).catch(() => null);
    out.push({ id: Number(r.id), name: (lh && lh.displayName) || r.name });
  }
  return out;
}

async function requestCode(db, rawEmail) {
  const email = normEmail(rawEmail);
  if (!email || email.length > 200 || !EMAIL.test(email)) throw new TprmError(400, 'Give the email address your invitation or questionnaire was sent to.', { errors: ['Give the email address your invitation or questionnaire was sent to.'] });
  const recent = (await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_vendor_codes WHERE email = ? AND created_at > now() - (?::integer * interval '1 minute')`)
    .get(email, LIMITS.codesPerEmailWindowMinutes)).n;
  if (recent >= LIMITS.codesPerEmail) return { email, sent: false, limited: true };
  const firms = await firmsFor(db, email);
  if (!firms.length) return { email, sent: false };
  const code = makeCode();
  await db.prepare(`INSERT INTO tp_vendor_codes (email, code_hash, expires_at) VALUES (?, ?, now() + (?::integer * interval '1 minute'))`)
    .run(email, sha(`${email}:${code}`), LIMITS.codeMinutes);
  return { email, sent: true, code, firm: firms[0], firms };
}

async function verifyCode(db, rawEmail, rawCode) {
  const email = normEmail(rawEmail);
  const code = String(rawCode || '').replace(/\s+/g, '');
  if (!email || !/^\d{6}$/.test(code)) return null;
  return await db.transaction(async () => {
    const row = await db.prepare(`SELECT id, code_hash, attempts FROM tp_vendor_codes WHERE email = ? AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`).get(email);
    if (!row || row.attempts >= LIMITS.codeAttempts) return null;
    const given = Buffer.from(sha(`${email}:${code}`));
    const expected = Buffer.from(row.code_hash);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      await db.prepare('UPDATE tp_vendor_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      return null;
    }
    await db.prepare('UPDATE tp_vendor_codes SET used_at = now() WHERE email = ? AND used_at IS NULL').run(email);
    const firms = await firmsFor(db, email);
    return firms.length ? { email, firms, codeId: Number(row.id) } : null;
  })();
}

async function recentlyVerified(db, email, codeId) {
  return !!(await db.prepare(`SELECT 1 FROM tp_vendor_codes WHERE id = ? AND email = ? AND used_at > now() - (?::integer * interval '1 minute')`)
    .get(Number(codeId) || 0, normEmail(email), LIMITS.codeMinutes));
}

async function createSession(db, { firmId, email, personId = null }) {
  if (!personId) await ensureLinkPeople(db, normEmail(email), firmId);
  const token = crypto.randomBytes(32).toString('base64url');
  await db.prepare(`INSERT INTO tp_vendor_sessions (token_hash, firm_id, email, person_id, expires_at)
    VALUES (?, ?, ?, ?, now() + (?::integer * interval '1 hour'))`).run(sha(token), firmId, normEmail(email), personId, LIMITS.sessionHours);
  return token;
}

async function loadSession(db, token) {
  const raw = String(token || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const tokenHash = sha(raw);
  const row = await db.prepare(`SELECT id, firm_id, email, person_id, expires_at, last_seen_at FROM tp_vendor_sessions
    WHERE token_hash = ? AND ended_at IS NULL AND expires_at > now() AND last_seen_at > now() - (?::integer * interval '1 minute')`)
    .get(tokenHash, LIMITS.idleMinutes);
  if (!row) return null;
  const people = await peopleForEmail(db, row.email, { firmId: Number(row.firm_id), personId: row.person_id ? Number(row.person_id) : null });
  if (!people.length) {
    await db.prepare('UPDATE tp_vendor_sessions SET ended_at = now() WHERE id = ?').run(row.id);
    return null;
  }
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60 * 1000) {
    await db.prepare('UPDATE tp_vendor_sessions SET last_seen_at = now() WHERE id = ?').run(row.id);
  }
  return { id: Number(row.id), tokenHash, firmId: Number(row.firm_id), email: row.email, scopedTo: row.person_id ? Number(row.person_id) : null, people };
}

async function accessEnded(db, token) {
  const raw = String(token || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const row = await db.prepare('SELECT firm_id, email, person_id FROM tp_vendor_sessions WHERE token_hash = ?').get(sha(raw));
  if (!row) return null;
  const personId = row.person_id ? Number(row.person_id) : null;
  if ((await peopleForEmail(db, row.email, { firmId: Number(row.firm_id), personId })).length) return null;
  const ended = await db.prepare(`SELECT DISTINCT t.name FROM tp_vendor_people p
    JOIN tp_third_parties t ON t.workspace_id = p.workspace_id AND t.id = p.third_party_id
    JOIN workspaces w ON w.id = p.workspace_id
    WHERE w.firm_id = ? AND ${personId ? 'p.id = ?' : 'p.email = ?'} AND (p.status = 'removed' OR t.status = 'exited')
      AND NOT EXISTS (SELECT 1 FROM tp_vendor_people again WHERE again.workspace_id = p.workspace_id AND again.third_party_id = p.third_party_id
        AND again.email = p.email AND again.status = 'active' AND t.status <> 'exited')
    ORDER BY t.name`).all(Number(row.firm_id), personId || row.email);
  if (!ended.length) return null;
  return { thirdParties: ended.map(r => r.name) };
}

async function endSession(db, token) {
  const raw = String(token || '');
  if (!raw) return;
  await db.prepare('UPDATE tp_vendor_sessions SET ended_at = now() WHERE token_hash = ? AND ended_at IS NULL').run(sha(raw));
}

function readCookie(req) {
  const header = String((req.headers && req.headers.cookie) || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

function cookieValue(token, { secure = process.env.NODE_ENV === 'production' } = {}) {
  const base = `${COOKIE}=${token}; Path=/vendor; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return token ? `${base}; Max-Age=${LIMITS.sessionHours * 3600}` : `${COOKIE}=; Path=/vendor; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0`;
}

function personFor(session, { workspaceId, thirdPartyId }) {
  return (session && session.people.find(p => p.workspace_id === Number(workspaceId) && p.third_party_id === Number(thirdPartyId))) || null;
}

module.exports = {
  PORTAL_PATH, COOKIE, LIMITS, normEmail, sha,
  requestCode, verifyCode, recentlyVerified, firmsFor, createSession, loadSession, accessEnded, endSession, readCookie, cookieValue, personFor, peopleForEmail,
};
