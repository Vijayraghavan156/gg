'use strict';

const access = require('./access');
const events = require('./events');
const { TprmError } = require('./errors');

const LIMITS = Object.freeze({ name: 200, email: 200, jobTitle: 200, phone: 60, perThirdParty: 50 });
const ROLE_LABELS = Object.freeze({ main: 'Main contact', colleague: 'Colleague' });
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const COLUMNS = `p.id, p.workspace_id, p.third_party_id, p.email, p.name, p.job_title, p.phone, p.role, p.status, p.created_at, p.updated_at, p.row_version`;

const str = v => (typeof v === 'string' ? v.trim() : '');
const normEmail = v => str(v).toLowerCase();
const invalid = errors => new TprmError(400, errors.join(' '), { errors });
const notFound = () => new TprmError(404, 'This person does not exist, or is not available to your account.');
const conflict = () => new TprmError(409, 'Someone else changed this person after you opened the page. Nothing was saved: reload the page and try again.');

function parse(input = {}, { emailRequired = true } = {}) {
  const v = { name: str(input.name), email: normEmail(input.email), job_title: str(input.job_title), phone: str(input.phone) };
  const errors = [];
  if (!v.name) errors.push('Give the person\'s name.');
  else if (v.name.length > LIMITS.name) errors.push(`The name must be ${LIMITS.name} characters or fewer.`);
  if (emailRequired) {
    if (!v.email) errors.push('Give the person\'s email address.');
    else if (v.email.length > LIMITS.email || !EMAIL.test(v.email)) errors.push('Give a valid email address, like name@company.com.');
  }
  if (v.job_title.length > LIMITS.jobTitle) errors.push(`The job title must be ${LIMITS.jobTitle} characters or fewer.`);
  if (v.phone.length > LIMITS.phone) errors.push(`The phone number must be ${LIMITS.phone} characters or fewer.`);
  else if (v.phone && !/^[+()0-9 .\-/x]+$/i.test(v.phone)) errors.push('Give the phone number with digits, spaces, + ( ) and - only.');
  if (errors.length) throw invalid(errors);
  return v;
}

async function append(db, workspaceId, thirdPartyId, actorId, action, before, after) {
  await events.appendEvent(db, { workspaceId, thirdPartyId, assessmentId: null, actorId, action, before, after });
}

async function list(db, workspaceId, thirdPartyId) {
  return await db.prepare(`SELECT ${COLUMNS} FROM tp_vendor_people p WHERE p.workspace_id = ? AND p.third_party_id = ? AND p.status = 'active'
    ORDER BY (p.role = 'main') DESC, lower(p.name), p.id`).all(workspaceId, thirdPartyId);
}

async function mainContact(db, workspaceId, thirdPartyId) {
  return await db.prepare(`SELECT ${COLUMNS} FROM tp_vendor_people p WHERE p.workspace_id = ? AND p.third_party_id = ? AND p.status = 'active' AND p.role = 'main'
    ORDER BY p.id LIMIT 1`).get(workspaceId, Number(thirdPartyId) || 0) || null;
}

async function withOpenLinks(db, workspaceId, thirdPartyId) {
  const rows = await db.prepare(`SELECT DISTINCT lower(trim(l.recipient_email)) AS email FROM (
      SELECT r.recipient_email, r.assessment_id, r.workspace_id FROM tp_vendor_requests r
        WHERE r.workspace_id = ? AND r.status IN ('active', 'submitted') AND r.expires_at > now()
      UNION ALL
      SELECT c.recipient_email, c.assessment_id, c.workspace_id FROM tp_condition_links c
        WHERE c.workspace_id = ? AND c.status = 'active' AND c.expires_at > now()) l
    JOIN tp_assessments a ON a.workspace_id = l.workspace_id AND a.id = l.assessment_id
    WHERE a.third_party_id = ? AND a.status <> 'cancelled'`).all(workspaceId, workspaceId, Number(thirdPartyId) || 0);
  return new Set(rows.map(r => r.email));
}

async function get(db, workspaceId, thirdPartyId, personId, { forUpdate = false } = {}) {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM tp_vendor_people p WHERE p.workspace_id = ? AND p.third_party_id = ? AND p.id = ? AND p.status = 'active'${forUpdate ? ' FOR UPDATE' : ''}`)
    .get(workspaceId, thirdPartyId, Number(personId) || 0);
  if (!row) throw notFound();
  return row;
}

async function lockThirdParty(db, workspaceId, thirdPartyId) {
  const tp = await db.prepare('SELECT id, name FROM tp_third_parties WHERE workspace_id = ? AND id = ? FOR UPDATE').get(workspaceId, Number(thirdPartyId) || 0);
  if (!tp) throw new TprmError(404, 'This third party does not exist, or is not available to your account.');
  return tp;
}

async function insert(db, workspaceId, thirdPartyId, v, role, { userId = null, personId = null } = {}) {
  const count = (await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_vendor_people WHERE workspace_id = ? AND third_party_id = ? AND status = 'active'`)
    .get(workspaceId, thirdPartyId)).n;
  if (count >= LIMITS.perThirdParty) throw new TprmError(409, `A third party can have at most ${LIMITS.perThirdParty} people. Remove someone first.`);
  const dup = await db.prepare(`SELECT id FROM tp_vendor_people WHERE workspace_id = ? AND third_party_id = ? AND email = ? AND status = 'active'`)
    .get(workspaceId, thirdPartyId, v.email);
  if (dup) throw invalid([`${v.email} is already one of the people at this third party.`]);
  return await db.prepare(`INSERT INTO tp_vendor_people (workspace_id, third_party_id, email, name, job_title, phone, role, added_by_user_id, added_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS.replace(/p\./g, '')}`)
    .get(workspaceId, thirdPartyId, v.email, v.name, v.job_title || null, v.phone || null, role, userId, personId);
}

function requireManage(actor) {
  if (!actor || !access.can(actor.user, actor.perms, 'tp.manage')) throw new TprmError(403, 'Your role does not allow changes to the people at a third party.');
}

async function firmAdd(db, actor, thirdPartyId, input = {}) {
  requireManage(actor);
  const v = parse(input);
  return await db.transaction(async () => {
    const tp = await lockThirdParty(db, actor.ws.id, thirdPartyId);
    const hasMain = await db.prepare(`SELECT 1 FROM tp_vendor_people WHERE workspace_id = ? AND third_party_id = ? AND status = 'active' AND role = 'main'`).get(actor.ws.id, tp.id);
    const role = !hasMain || input.role === 'main' ? 'main' : 'colleague';
    if (hasMain && role === 'main') {
      await db.prepare(`UPDATE tp_vendor_people SET role = 'colleague', updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND third_party_id = ? AND status = 'active' AND role = 'main'`).run(actor.ws.id, tp.id);
    }
    const person = await insert(db, actor.ws.id, tp.id, v, role, { userId: actor.user.id });
    await append(db, actor.ws.id, tp.id, actor.user.id, 'vendor_person.added', null, { person_id: Number(person.id), name: person.name, email: person.email, role, by: 'firm' });
    return person;
  })();
}

async function firmUpdate(db, actor, thirdPartyId, personId, input = {}) {
  requireManage(actor);
  const v = parse(input);
  return await db.transaction(async () => {
    const tp = await lockThirdParty(db, actor.ws.id, thirdPartyId);
    const p = await get(db, actor.ws.id, tp.id, personId, { forUpdate: true });
    if (input.row_version !== undefined && Number(input.row_version) !== Number(p.row_version)) throw conflict();
    if (v.email !== p.email) {
      const dup = await db.prepare(`SELECT id FROM tp_vendor_people WHERE workspace_id = ? AND third_party_id = ? AND email = ? AND status = 'active' AND id <> ?`)
        .get(actor.ws.id, tp.id, v.email, p.id);
      if (dup) throw invalid([`${v.email} is already one of the people at this third party.`]);
      await endSessionsFor(db, p.id);
    }
    await db.prepare(`UPDATE tp_vendor_people SET name = ?, email = ?, job_title = ?, phone = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ?`).run(v.name, v.email, v.job_title || null, v.phone || null, actor.ws.id, p.id);
    await append(db, actor.ws.id, tp.id, actor.user.id, 'vendor_person.changed', { name: p.name, email: p.email }, { person_id: Number(p.id), name: v.name, email: v.email, by: 'firm' });
    return { ...p, ...v, emailChanged: v.email !== p.email };
  })();
}

async function endSessionsFor(db, personId) {
  const p = await db.prepare('SELECT p.email, w.firm_id FROM tp_vendor_people p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = ?').get(personId);
  await db.prepare('UPDATE tp_vendor_sessions SET ended_at = now() WHERE ended_at IS NULL AND (person_id = ? OR (person_id IS NULL AND firm_id = ? AND email = ?))')
    .run(personId, p ? p.firm_id : 0, p ? p.email : '');
}

async function removeOne(db, workspaceId, tpId, p, { actorId, by, byName = null }) {
  if (p.role === 'main') throw new TprmError(409, 'The main contact cannot be removed. Make someone else the main contact first.');
  await db.prepare(`UPDATE tp_vendor_people SET status = 'removed', removed_at = now(), updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
    .run(workspaceId, p.id);
  await db.prepare('DELETE FROM tp_vendor_assignments WHERE workspace_id = ? AND person_id = ?').run(workspaceId, p.id);
  await endSessionsFor(db, p.id);
  await append(db, workspaceId, tpId, actorId, 'vendor_person.removed', { person_id: Number(p.id), name: p.name, email: p.email }, { status: 'removed', by, ...(byName ? { by_name: byName } : {}) });
}

async function firmRemove(db, actor, thirdPartyId, personId) {
  requireManage(actor);
  return await db.transaction(async () => {
    const tp = await lockThirdParty(db, actor.ws.id, thirdPartyId);
    const p = await get(db, actor.ws.id, tp.id, personId, { forUpdate: true });
    await removeOne(db, actor.ws.id, tp.id, p, { actorId: actor.user.id, by: 'firm' });
    return p;
  })();
}

async function makeMain(db, workspaceId, tpId, p, { actorId, by, byName = null }) {
  if (p.role === 'main') return p;
  const old = await db.prepare(`SELECT id, name FROM tp_vendor_people WHERE workspace_id = ? AND third_party_id = ? AND status = 'active' AND role = 'main' FOR UPDATE`).get(workspaceId, tpId);
  if (old) await db.prepare(`UPDATE tp_vendor_people SET role = 'colleague', updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(workspaceId, old.id);
  await db.prepare(`UPDATE tp_vendor_people SET role = 'main', updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(workspaceId, p.id);
  await append(db, workspaceId, tpId, actorId, 'vendor_person.made_main', old ? { person_id: Number(old.id), name: old.name } : null, { person_id: Number(p.id), name: p.name, by, ...(byName ? { by_name: byName } : {}) });
  return { ...p, role: 'main' };
}

async function firmMakeMain(db, actor, thirdPartyId, personId) {
  requireManage(actor);
  return await db.transaction(async () => {
    const tp = await lockThirdParty(db, actor.ws.id, thirdPartyId);
    const p = await get(db, actor.ws.id, tp.id, personId, { forUpdate: true });
    return await makeMain(db, actor.ws.id, tp.id, p, { actorId: actor.user.id, by: 'firm' });
  })();
}

function requireMain(person) {
  if (!person || person.role !== 'main') throw new TprmError(403, 'Only the main contact can add or remove people.');
}

async function vendorInvite(db, person, input = {}) {
  requireMain(person);
  const v = parse(input);
  return await db.transaction(async () => {
    await lockThirdParty(db, person.workspace_id, person.third_party_id);
    const added = await insert(db, person.workspace_id, person.third_party_id, v, 'colleague', { personId: person.id });
    await append(db, person.workspace_id, person.third_party_id, null, 'vendor_person.added', null,
      { person_id: Number(added.id), name: added.name, email: added.email, role: 'colleague', by: 'third_party', by_person_id: Number(person.id), by_name: person.name });
    return added;
  })();
}

async function vendorRemove(db, person, personId) {
  requireMain(person);
  return await db.transaction(async () => {
    await lockThirdParty(db, person.workspace_id, person.third_party_id);
    const p = await get(db, person.workspace_id, person.third_party_id, personId, { forUpdate: true });
    await removeOne(db, person.workspace_id, person.third_party_id, p, { actorId: null, by: 'third_party', byName: person.name });
    return p;
  })();
}

async function vendorHandOver(db, person, personId) {
  requireMain(person);
  return await db.transaction(async () => {
    await lockThirdParty(db, person.workspace_id, person.third_party_id);
    const p = await get(db, person.workspace_id, person.third_party_id, personId, { forUpdate: true });
    return await makeMain(db, person.workspace_id, person.third_party_id, p, { actorId: null, by: 'third_party', byName: person.name });
  })();
}

async function vendorUpdateSelf(db, person, input = {}) {
  const v = parse({ ...input, email: person.email });
  await db.prepare(`UPDATE tp_vendor_people SET name = ?, job_title = ?, phone = ?, updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
    .run(v.name, v.job_title || null, v.phone || null, person.workspace_id, person.id);
  await append(db, person.workspace_id, person.third_party_id, null, 'vendor_person.changed', { name: person.name }, { person_id: Number(person.id), name: v.name, by: 'third_party', by_name: v.name });
  return { ...person, ...v, email: person.email };
}

async function assignments(db, workspaceId, assessmentId) {
  const rows = await db.prepare(`SELECT s.section_title, s.person_id, p.name FROM tp_vendor_assignments s
    JOIN tp_vendor_people p ON p.id = s.person_id AND p.status = 'active'
    WHERE s.workspace_id = ? AND s.assessment_id = ?`).all(workspaceId, assessmentId);
  return new Map(rows.map(r => [r.section_title, { personId: Number(r.person_id), name: r.name }]));
}

async function assignSections(db, person, assessmentId, sectionTitles, input = {}) {
  requireMain(person);
  const people = await list(db, person.workspace_id, person.third_party_id);
  const byId = new Map(people.map(p => [Number(p.id), p]));
  const wanted = new Map();
  for (const title of sectionTitles) {
    const raw = input && input.assign && Object.prototype.hasOwnProperty.call(input.assign, title) ? String(input.assign[title]) : '';
    if (!raw) { wanted.set(title, null); continue; }
    const who = byId.get(Number(raw));
    if (!who) throw invalid([`Choose someone from the people at ${person.third_party_name || 'your company'} for "${title}".`]);
    wanted.set(title, who);
  }
  return await db.transaction(async () => {
    const a = await db.prepare('SELECT id FROM tp_assessments WHERE workspace_id = ? AND id = ? AND third_party_id = ? FOR UPDATE')
      .get(person.workspace_id, Number(assessmentId) || 0, person.third_party_id);
    if (!a) throw notFound();
    const before = await assignments(db, person.workspace_id, a.id);
    const newly = [];
    for (const [title, who] of wanted) {
      const old = before.get(title);
      if (!who) {
        if (old) await db.prepare('DELETE FROM tp_vendor_assignments WHERE workspace_id = ? AND assessment_id = ? AND section_title = ?').run(person.workspace_id, a.id, title);
        continue;
      }
      if (old && old.personId === Number(who.id)) continue;
      await db.prepare(`INSERT INTO tp_vendor_assignments (workspace_id, assessment_id, section_title, person_id, assigned_by_person_id)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id, assessment_id, section_title)
        DO UPDATE SET person_id = EXCLUDED.person_id, assigned_by_person_id = EXCLUDED.assigned_by_person_id, assigned_at = now()`)
        .run(person.workspace_id, a.id, title, who.id, person.id);
      newly.push({ title, person: who });
    }
    if (newly.length || [...wanted].some(([t, w]) => !w && before.has(t))) {
      await events.appendEvent(db, { workspaceId: person.workspace_id, thirdPartyId: person.third_party_id, assessmentId: a.id, actorId: null,
        action: 'vendor_sections.assigned', before: null,
        after: { by: 'third_party', by_person_id: Number(person.id), by_name: person.name, sections: [...wanted].map(([t, w]) => ({ title: t, person: w ? w.name : null })) } });
    }
    return { newly };
  })();
}

async function forLinkRecipient(db, { workspaceId, thirdPartyId, email, name }) {
  const e = normEmail(email);
  if (!e || !EMAIL.test(e)) return null;
  const existing = await db.prepare(`SELECT ${COLUMNS} FROM tp_vendor_people p WHERE p.workspace_id = ? AND p.third_party_id = ? AND p.email = ? AND p.status = 'active'`)
    .get(workspaceId, thirdPartyId, e);
  if (existing) return existing;
  return await db.transaction(async () => {
    await lockThirdParty(db, workspaceId, thirdPartyId);
    const again = await db.prepare(`SELECT ${COLUMNS} FROM tp_vendor_people p WHERE p.workspace_id = ? AND p.third_party_id = ? AND p.email = ? AND p.status = 'active'`)
      .get(workspaceId, thirdPartyId, e);
    if (again) return again;
    const hasMain = await db.prepare(`SELECT 1 FROM tp_vendor_people WHERE workspace_id = ? AND third_party_id = ? AND status = 'active' AND role = 'main'`).get(workspaceId, thirdPartyId);
    const person = await insert(db, workspaceId, thirdPartyId, { email: e, name: str(name).slice(0, LIMITS.name) || e, job_title: '', phone: '' }, hasMain ? 'colleague' : 'main');
    await append(db, workspaceId, thirdPartyId, null, 'vendor_person.joined', null, { person_id: Number(person.id), name: person.name, email: person.email, role: person.role, by: 'link' });
    return person;
  })();
}

module.exports = {
  LIMITS, ROLE_LABELS, normEmail, parse, list, get, mainContact, withOpenLinks,
  firmAdd, firmUpdate, firmRemove, firmMakeMain,
  vendorInvite, vendorRemove, vendorHandOver, vendorUpdateSelf, forLinkRecipient, endSessionsFor, assignments, assignSections,
};
