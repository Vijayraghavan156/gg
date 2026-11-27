'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'summary-counts-tests-password-1234';
const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let day;
const sessions = [];
const createdPaths = new Set();

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId, workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firm : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email, firm_role: type === 'firm' ? role : null };
}

async function sessionFor(user) {
  if (user.session) return user.session;
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email: user.email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${user.email} signs in`);
  await session.get('/dashboard');
  sessions.push(session);
  user.session = session;
  return session;
}

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`sc-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
  return { id, owner };
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const said = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const ymd = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const firmTp = (ws, tp) => `/tprm/clients/${ws}/third-parties/${tp}`;
const portalTp = (ws, tp) => `/workspaces/${ws}/client-portal/third-party-risk/third-parties/${tp}`;
const aBase = (ws, tp, a) => `${firmTp(ws, tp)}/assessments/${a}`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const recRow = async id => db.prepare('SELECT * FROM tp_recommendations WHERE id=?').get(id);
const section = (text, marker) => {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `${marker} is on the page`);
  return text.slice(at, text.indexOf('</section>', at));
};

async function addThirdParty(ws, name, status = 'in_use') {
  const s = await sessionFor(consultant);
  const res = await s.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await s.post(`${firmTp(ws, tp)}/services`, { description: 'Hosting' })).status, 302);
  return tp;
}

function multipart(token, file, fields = {}) {
  const boundary = '----tprmsc' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (token) parts.push(`--${boundary}`, 'Content-Disposition: form-data; name="_csrf"', '', token);
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  if (file) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${file.filename}"`,
      `Content-Type: ${file.type || 'application/pdf'}`, '', file.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function fileDoc(ws, tp, fields, file = { filename: 'doc.pdf', content: `${PDF}% ${crypto.randomBytes(4).toString('hex')}\n` }) {
  const s = await sessionFor(consultant);
  await s.get(firmTp(ws, tp));
  const form = multipart(s.getCsrfToken(), file, fields);
  const res = await s.post(`${firmTp(ws, tp)}/documents`, form.body, { headers: form.headers });
  for (const r of await db.prepare('SELECT stored_path FROM tp_party_documents WHERE workspace_id=?').all(ws)) createdPaths.add(r.stored_path);
  return res;
}

async function shareDoc(ws, tp, title) {
  const row = await db.prepare('SELECT id, row_version FROM tp_party_documents WHERE workspace_id=? AND title=?').get(ws, title);
  const res = await (await sessionFor(consultant)).post(`${firmTp(ws, tp)}/documents/${row.id}/share`, { shared: '1', row_version: String(row.row_version) });
  assert.equal(res.status, 302, said(res));
}

async function confirmed(ws, name) {
  const tp = await addThirdParty(ws, name);
  const s = await sessionFor(consultant);
  const started = await s.post(`${firmTp(ws, tp)}/assessments`, {});
  assert.equal(started.status, 302);
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await s.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  assert.equal((await (await sessionFor(senior)).post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  return { ws, tp, a };
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('sc-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('sc-senior@test.local', { role: 'senior_consultant' });
  day = require('../lib/tprm/format').forZone('UTC', { ymdInZone: require('../lib/dates').ymdInZone }).day;
});

test.after(async () => {
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      for (const sub of fs.existsSync(path.join(ROOT, 'uploads', dir)) && fs.statSync(path.join(ROOT, 'uploads', dir)).isDirectory() ? ['', ...fs.readdirSync(path.join(ROOT, 'uploads', dir))] : []) {
        try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, sub, stored)); } catch (_) {}
      }
    }
  }
  for (const s of sessions) await s.close();
  if (client) await client.close();
});

test('the supplier overview counts filed documents, what the client sees of them and what expires, and the client overview counts the same', async () => {
  const c = await tprmClient('Summary Docs Client');
  const tp = await addThirdParty(c.id, 'Deskline Docs');
  for (const f of [
    { kind: 'iso27001_certificate', title: 'ISO certificate', expires_on: ymd(600) },
    { kind: 'insurance_certificate', title: 'Cyber cover', expires_on: ymd(34) },
    { kind: 'contract', title: 'Master agreement', expires_on: ymd(120) },
    { kind: 'policy', title: 'Old policy', expires_on: ymd(-10) },
  ]) assert.equal((await fileDoc(c.id, tp, f)).status, 302);
  await shareDoc(c.id, tp, 'ISO certificate');

  const page = await (await sessionFor(consultant)).get(firmTp(c.id, tp));
  assert.equal(page.status, 200);
  const card = section(page.text, 'data-tprm-party-docs-card');
  assert.match(card, /4 held, 1 shared with the client/);
  assert.match(card, /<div class="fx-big">2 <span class="fx-of">expire in 12 months/);
  assert.match(card, new RegExp(`Cyber cover ${day(ymd(34))}, Master agreement ${day(ymd(120))}`));
  assert.match(card, /1 already expired/);
  assert.doesNotMatch(card, /Nothing expiring/);

  const portal = await (await sessionFor(c.owner)).get(portalTp(c.id, tp));
  assert.equal(portal.status, 200);
  assert.match(portal.text, /data-tprm-cv-party-tab="documents">Documents <small>1<\/small>/);
  const clientCard = section(portal.text, 'data-tprm-cv-docs-card');
  assert.match(clientCard, /<div class="cv-big">1<\/div>/);
  assert.match(clientCard, /1 supplier document/);
});

test('the client Assurance box includes a certificate filed and shared with the client, as the firm page does', async () => {
  const c = await tprmClient('Summary Assurance Client');
  const tp = await addThirdParty(c.id, 'Shared Cert Co');
  assert.equal((await fileDoc(c.id, tp, { kind: 'iso27001_certificate', title: 'ISO certificate', expires_on: ymd(500) })).status, 302);
  const portal = s => s.get(portalTp(c.id, tp));
  let box = section((await portal(await sessionFor(c.owner))).text, 'data-tprm-cv-assurance');
  assert.match(box, /data-tprm-cv-assurance-iso><dt>ISO 27001<\/dt><dd><span class="cv-muted">Not provided/, 'a filed certificate not shared stays hidden');
  await shareDoc(c.id, tp, 'ISO certificate');
  const page = (await portal(await sessionFor(c.owner))).text;
  const at = page.indexOf('data-tprm-cv-assurance-iso');
  box = page.slice(at, page.indexOf('</div>', at));
  assert.match(box, new RegExp(`Valid to ${day(ymd(500))} <span class="cv-muted cv-small">from a shared document</span>`));
});

test('the register counts a filed document that expires within 90 days', async () => {
  const c = await tprmClient('Summary Register Client');
  const tp = await addThirdParty(c.id, 'Register Docs Co');
  assert.equal((await fileDoc(c.id, tp, { kind: 'insurance_certificate', title: 'Cover note', expires_on: ymd(30) })).status, 302);
  assert.equal((await fileDoc(c.id, tp, { kind: 'contract', title: 'Long contract', expires_on: ymd(400) })).status, 302);
  const register = await (await sessionFor(consultant)).get(`/tprm/clients/${c.id}`);
  assert.equal(register.status, 200);
  assert.match(register.text, /<b>1<\/b><span>Third parties with a document expiring<\/span>/, (register.text.match(/.{0,200}document expiring/) || [''])[0]);
  const gone = await addThirdParty(c.id, 'Exited Docs Co');
  assert.equal((await fileDoc(c.id, gone, { kind: 'insurance_certificate', title: 'Old cover', expires_on: ymd(20) })).status, 302);
  assert.equal((await fileDoc(c.id, gone, { kind: 'contract', title: 'Old contract', expires_on: ymd(25) })).status, 302);
  await db.prepare("UPDATE tp_third_parties SET status = 'exited' WHERE id = ?").run(gone);
  const later = await (await sessionFor(consultant)).get(`/tprm/clients/${c.id}`);
  assert.match(later.text, /<b>1<\/b><span>Third parties with a document expiring<\/span>/, 'an exited supplier is left out, and two documents of one supplier count once');
});

test('the certificate that runs longest counts as assurance even when the questionnaire gave an older one', () => {
  const { mergeAssurance } = require('../lib/tprm/firm-party');
  const report = { kind: 'iso27001', expires_on: ymd(-40), period_end: null, check_status: 'accepted' };
  const filed = { kind: 'iso27001', expires_on: ymd(500), name: 'Renewed ISO', source: 'document' };
  const iso = mergeAssurance([report], [filed]).find(r => r.kind === 'iso27001');
  assert.equal(iso.source, 'document');
  assert.equal(iso.expires_on, ymd(500));
  const same = { kind: 'iso27001', expires_on: ymd(500), period_end: null, check_status: 'accepted' };
  assert.equal(mergeAssurance([same], [filed]).find(r => r.kind === 'iso27001').source, 'report', 'on the same expiry the checked report is kept');
  const soc = { kind: 'soc2_type2', expires_on: null, period_end: ymd(-100), check_status: 'accepted' };
  const newerSoc = { kind: 'soc2_type2', expires_on: ymd(60), name: 'New SOC 2' };
  const merged = mergeAssurance([soc], [newerSoc]).find(r => r.kind === 'soc2_type2');
  assert.equal(merged.source, 'evidence');
  assert.equal(merged.period_end, ymd(60));
});

test('Due for reassessment leaves out a supplier already being assessed', async () => {
  const c = await tprmClient('Summary Due Client');
  const waiting = await addThirdParty(c.id, 'Waiting Due Co');
  const assessing = await addThirdParty(c.id, 'Assessing Due Co');
  await db.prepare(`UPDATE tp_third_parties SET last_assessment_date='2024-01-10', next_due_date='2025-01-10' WHERE id IN (?, ?)`).run(waiting, assessing);
  const started = await (await sessionFor(consultant)).post(`${firmTp(c.id, assessing)}/assessments`, {});
  assert.equal(started.status, 302);
  const due = await (await sessionFor(consultant)).get(`/tprm/clients/${c.id}?view=due`);
  assert.equal(due.status, 200);
  assert.match(due.text, new RegExp(`data-tprm-row="${waiting}"`));
  assert.doesNotMatch(due.text, new RegExp(`data-tprm-row="${assessing}"`));
  assert.match(due.text, /Due for reassessment \(1\)/);
});

test('firm home counts a client reassessment request apart from requests to add a supplier', async () => {
  const c = await tprmClient('Summary Requests Client');
  const tp = await addThirdParty(c.id, 'Request Reassess Co');
  await db.prepare(`UPDATE tp_third_parties SET last_assessment_date='2025-06-01', next_due_date='2027-06-01' WHERE id=?`).run(tp);
  const owner = await sessionFor(c.owner);
  await owner.get(portalTp(c.id, tp));
  const asked = await owner.post(`${portalTp(c.id, tp)}/reassessment-requests`, { reason: 'They had an incident' });
  assert.equal(asked.status, 302, said(asked));
  assert.match(said(asked), /asked to reassess Request Reassess Co/);
  const home = await client.get('/tprm');
  assert.equal(home.status, 200);
  const you = section(home.text, 'data-tprm-hub-tile="you"');
  assert.match(you, /Client requests to add<b>0<\/b>/);
  assert.match(you, /Client requests to reassess<b>1<\/b>/);
  const card = section(home.text, `data-tprm-client-row="${c.id}"`);
  assert.match(card, /data-tprm-client-requests="add">Requests to add<b>0<\/b>/);
  assert.match(card, /data-tprm-client-requests="reassess">Requests to reassess<b>1<\/b>/);
});

test('the client page words a supplier assessed before the tool, never assessed, or exited honestly', async () => {
  const c = await tprmClient('Summary Wording Client');
  const imported = await addThirdParty(c.id, 'Northgate Wording');
  await db.prepare(`UPDATE tp_third_parties SET last_assessment_date='2024-09-15', next_due_date='2025-09-15', current_tier='critical',
    tier_source='provisional_from_client_label' WHERE id=?`).run(imported);
  const owner = await sessionFor(c.owner);
  const page = await owner.get(portalTp(c.id, imported));
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Not assessed yet/);
  assert.match(page.text, /data-tprm-cv-approval="not_yet_assessed">No decision recorded</);
  assert.match(page.text, /data-tprm-cv-tier>Critical tier \(provisional\)</);
  assert.match(page.text, /<dt>Tier<\/dt><dd>Critical \(provisional\)<\/dd>/);
  assert.match(page.text, /<dt>Next review<\/dt><dd>15 Sep 2025, overdue<\/dd>/);
  assert.match(page.text, /<h3 class="cv-h4">Ask for a reassessment<\/h3>/);

  const fresh = await addThirdParty(c.id, 'Varma Wording');
  const never = await owner.get(portalTp(c.id, fresh));
  assert.match(never.text, /<h3 class="cv-h4">Ask for an assessment<\/h3>/);
  assert.match(never.text, /<button class="cv-btn cv-btn-p" type="submit">Ask for an assessment<\/button>/);
  assert.doesNotMatch(never.text, /Ask for a reassessment|to reassess it/);

  await db.prepare(`UPDATE tp_third_parties SET status='exited' WHERE id=?`).run(fresh);
  const exited = await owner.get(portalTp(c.id, fresh));
  assert.match(exited.text, /<dt>Next review<\/dt><dd>None, the supplier has exited<\/dd>/);
  assert.doesNotMatch(exited.text, /After the first assessment/);
});

test('a refused reassessment request keeps the reason and date and shows the error on the form', async () => {
  const c = await tprmClient('Summary Refusal Client');
  const tp = await addThirdParty(c.id, 'Refused Request Co');
  await db.prepare(`UPDATE tp_third_parties SET last_assessment_date='2025-06-01', next_due_date='2027-06-01' WHERE id=?`).run(tp);
  const owner = await sessionFor(c.owner);
  await owner.get(portalTp(c.id, tp));
  const res = await owner.post(`${portalTp(c.id, tp)}/reassessment-requests`, { reason: 'They moved data centres', preferred_date: '2001-01-01' });
  assert.equal(res.status, 400);
  const form = section(res.text.replace(/<\/form>/, '</section>'), 'data-tprm-cv-reassess-form');
  assert.match(form, /data-tprm-cv-reassess-errors[^>]*>[\s\S]*cannot be in the past/);
  assert.match(form, />They moved data centres<\/textarea>/);
  assert.match(form, /value="2001-01-01"/);
  assert.match(form, /min="\d{4}-\d{2}-\d{2}"/);
  assert.equal((await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_client_requests WHERE third_party_id=?`).get(tp)).n, 0);
});

test('a refused supplier document keeps what was typed and says the file must be chosen again', async () => {
  const c = await tprmClient('Summary Doc Refusal Client');
  const tp = await addThirdParty(c.id, 'Refused Doc Co');
  const res = await fileDoc(c.id, tp, { kind: 'contract', title: 'Master agreement 2026', issued_on: '2026-05-10', expires_on: '2026-01-01' });
  assert.equal(res.status, 400);
  assert.match(res.text, /data-tprm-party-document-form/);
  assert.match(res.text, /data-tprm-form-errors[\s\S]*cannot be before the issue date/);
  assert.match(res.text, /<option value="contract" selected>/);
  assert.match(res.text, /name="title" maxlength="200" required value="Master agreement 2026"/);
  assert.match(res.text, /name="issued_on" value="2026-05-10"/);
  assert.match(res.text, /name="expires_on" value="2026-01-01"/);
  assert.match(res.text, /data-tprm-party-library-choose-again>[^<]*Choose the file again/);
  assert.equal((await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_party_documents WHERE third_party_id=?`).get(tp)).n, 0);
});

test('the agreed fix on the client issue thread reads as one sentence with its date', async () => {
  const c = await tprmClient('Summary Thread Client');
  const ctx = await confirmed(c.id, 'Thread Fix Co');
  const s = await sessionFor(consultant);
  assert.equal((await s.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings`, { status: 'open', control_ref: 'A.8.8', severity: 'high', title: 'Unpatched terminals', description: 'Terminals run an old build.' })).status, 302);
  const finding = await db.prepare('SELECT id FROM tp_findings WHERE assessment_id=?').get(ctx.a);
  await db.prepare(`UPDATE tp_assessments SET client_decision_owner_id=? WHERE id=?`).run(c.owner.id, ctx.a);
  const draft = await s.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations`, { row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(draft.status, 302, said(draft));
  const rid = Number((await db.prepare(`SELECT id FROM tp_recommendations WHERE assessment_id=? ORDER BY id DESC LIMIT 1`).get(ctx.a)).id);
  const saved = await s.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations/${rid}`, { outcome: 'approve', residual_rating: 'medium', rationale: 'Adequate.',
    valid_until: '2099-12-31', intent: 'submit', row_version: String((await recRow(rid)).row_version) });
  assert.equal(saved.status, 302, said(saved));
  const issuedRes = await (await sessionFor(senior)).post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations/${rid}/issue`, { row_version: String((await recRow(rid)).row_version) });
  assert.equal(issuedRes.status, 302, said(issuedRes));
  assert.equal((await recRow(rid)).status, 'issued');
  await db.prepare(`INSERT INTO tp_issues (workspace_id, assessment_id, finding_id, title, body, status, agreed_fix, agreed_date, agreed_at, shared_by)
    VALUES (?, ?, ?, 'Patching', 'How will the terminals be patched?', 'agreed', 'Pilot on 10 terminals in December.', '2027-01-31', now(), ?)`).run(ctx.ws, ctx.a, finding.id, consultant.id);
  const page = await (await sessionFor(c.owner)).get(`${portalTp(c.id, ctx.tp)}?tab=issues`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Fix agreed with the supplier:<\/b> Pilot on 10 terminals in December \(by 31 Jan 2027\)<\/p>/);
  assert.doesNotMatch(page.text, /December\., by/);
});
