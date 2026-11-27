'use strict';

for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-rr-outbox-')), 'outbox.log');

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'reassess-request-tests-password-1234';

let env;
let client;
let db;
let firmId;
let otherFirmId;
let consultant;
let outsider;
let A;
let B;
const sessions = [];

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId, workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firm : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email };
}

async function signIn(user) {
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

async function tprmClient(name, { frameworks = '["iso27001"]' } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,?,'certification_support')`).run(firmId, name, frameworks)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, consultant.id, 'consultant');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id,
    owner: await makeUser(`rr-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' }),
    contributor: await makeUser(`rr-contrib-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'contributor' }),
  };
}

async function supplier(ws, name, status = 'in_use') {
  const s = await signIn(consultant);
  const res = await s.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = Number((String(res.location).match(/third-parties\/(\d+)/) || [])[1]);
  assert.equal((await s.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosted service' })).status, 302);
  await db.prepare(`UPDATE tp_third_parties SET last_assessment_date='2025-06-01', next_due_date='2027-06-01', current_tier='medium', tier_source='assessed' WHERE id=?`).run(tp);
  return tp;
}

const portal = ws => `/workspaces/${ws}/client-portal/third-party-risk`;
const partyPage = (ws, tp) => `${portal(ws)}/third-parties/${tp}`;
const ask = (session, ws, tp, body) => session.post(`${partyPage(ws, tp)}/reassessment-requests`, body);
const said = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const requestRow = async id => db.prepare('SELECT *, preferred_date::text AS preferred_date FROM tp_client_requests WHERE id=?').get(id);
const requestsFor = async tp => db.prepare("SELECT * FROM tp_client_requests WHERE third_party_id=? AND kind='reassessment' ORDER BY id").all(tp);
const ymd = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  otherFirmId = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Other Reassess Firm')").run()).lastInsertRowid);
  consultant = await makeUser('rr-consultant@test.local');
  outsider = await makeUser('rr-outsider@test.local', { role: 'manager', firm: otherFirmId });
  A = await tprmClient('Reassess Client A');
  B = await tprmClient('Reassess Client B');
});

test.after(async () => {
  for (const s of sessions) await s.close();
  if (client) await client.close();
});

test('the client asks for a reassessment with a reason, sees it on the Requests tab, and cannot ask twice', async () => {
  const tp = await supplier(A.id, 'Hosting Co');
  const s = await signIn(A.owner);
  const page = await s.get(partyPage(A.id, tp));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-cv-reassess-form/);

  const empty = await ask(s, A.id, tp, { reason: '  ', preferred_date: '' });
  assert.equal(empty.status, 400);
  assert.match(empty.text, /Why you want it reassessed is required/);
  const past = await ask(s, A.id, tp, { reason: 'They moved data centres', preferred_date: '2001-01-01' });
  assert.equal(past.status, 400);
  assert.match(past.text, /cannot be in the past/);
  assert.equal((await requestsFor(tp)).length, 0);

  const res = await ask(s, A.id, tp, { reason: 'They moved data centres', preferred_date: ymd(20) });
  assert.equal(res.status, 302);
  const rid = Number((String(res.location).match(/requests\/(\d+)/) || [])[1]);
  assert.ok(rid);
  const row = await requestRow(rid);
  assert.equal(row.kind, 'reassessment');
  assert.equal(row.status, 'submitted');
  assert.equal(Number(row.third_party_id), tp);
  assert.equal(row.service_description, 'They moved data centres');
  assert.equal(row.preferred_date, ymd(20));
  assert.equal(Number(row.requested_by), A.owner.id);

  const view = await s.get(`${portal(A.id)}/requests/${rid}`);
  assert.equal(view.status, 200);
  assert.match(view.text, /data-tprm-cv-request-kind="reassessment"/);
  assert.match(view.text, /Reassessment of Hosting Co/);
  assert.match(view.text, /They moved data centres/);
  const tab = await s.get(`${portal(A.id)}?tab=requests`);
  assert.match(tab.text, new RegExp(`data-tprm-cv-request="${rid}" data-tprm-cv-request-status="submitted"`));
  assert.match(tab.text, /Reassessment: They moved data centres/);
  const again = await s.get(partyPage(A.id, tp));
  assert.match(again.text, new RegExp(`data-tprm-cv-reassess-requested="${rid}"`));
  assert.doesNotMatch(again.text, /data-tprm-cv-reassess-form/);

  const dup = await ask(s, A.id, tp, { reason: 'Asking again' });
  assert.equal(dup.status, 302);
  assert.match(said(dup), new RegExp(`requests/${rid}`));
  assert.match(said(dup), /already asked/);
  assert.equal((await requestsFor(tp)).length, 1);
  const raced = await db.prepare(`INSERT INTO tp_client_requests (workspace_id, kind, name, service_description, third_party_id, requested_by)
    VALUES (?, 'reassessment', 'Hosting Co', 'Race', ?, ?)`).run(A.id, tp, A.owner.id).then(() => null, err => err);
  assert.ok(raced, 'the database refuses a second open reassessment request for the same supplier');
});

test('the consultants see it in the request queue and accepting starts a reassessment of that supplier', async () => {
  const tp = await supplier(A.id, 'Payments Co');
  const s = await signIn(A.owner);
  const res = await ask(s, A.id, tp, { reason: 'New payment flows' });
  const rid = Number((String(res.location).match(/requests\/(\d+)/) || [])[1]);

  const c = await signIn(consultant);
  const home = await c.get(`/tprm/clients/${A.id}`);
  assert.match(home.text, new RegExp(`data-tprm-client-request="${rid}"`));
  assert.match(home.text, /Reassess Payments Co/);
  const firmHome = await c.get('/tprm');
  assert.match(firmHome.text, /Reassess at the client&#39;s request|Reassess at the client's request/);
  const page = await c.get(`/tprm/clients/${A.id}/requests/${rid}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-client-request-kind="reassessment"/);
  assert.match(page.text, /Start the reassessment/);

  const row = await requestRow(rid);
  const accepted = await c.post(`/tprm/clients/${A.id}/requests/${rid}/accept`, { row_version: String(row.row_version) });
  assert.equal(accepted.status, 302, accepted.text.slice(0, 300));
  const aid = Number((String(accepted.location).match(/assessments\/(\d+)/) || [])[1]);
  assert.ok(aid, said(accepted));
  const assessment = await db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(aid);
  assert.equal(Number(assessment.third_party_id), tp);
  assert.equal(assessment.type, 'reassessment');
  assert.equal(assessment.status, 'scoping');
  const after = await requestRow(rid);
  assert.equal(after.status, 'accepted');
  assert.equal(Number(after.assessment_id), aid);
  assert.equal(Number(after.decided_by), consultant.id);

  const view = await s.get(`${portal(A.id)}/requests/${rid}`);
  assert.match(view.text, /data-tprm-cv-request-view-status="accepted"/);
  assert.match(view.text, /Reassessment started/);
  const party = await s.get(partyPage(A.id, tp));
  assert.doesNotMatch(party.text, /data-tprm-cv-reassess-form/, 'no form while the review is open');
  const blocked = await ask(s, A.id, tp, { reason: 'Again' });
  assert.match(said(blocked), /already has a review open/);
  assert.match((await s.get(`${portal(A.id)}/account`)).text, /Reassessment of Payments Co started/);

  const twice = await c.post(`/tprm/clients/${A.id}/requests/${rid}/accept`, { row_version: String(after.row_version) });
  assert.equal(twice.status, 409);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) c FROM tp_assessments WHERE third_party_id=?').get(tp)).c), 1);
});

test('a declined or withdrawn request frees the supplier for a new request, and proposed suppliers cannot be asked', async () => {
  const tp = await supplier(A.id, 'Mail Co');
  const s = await signIn(A.owner);
  const first = Number((String((await ask(s, A.id, tp, { reason: 'Phishing incident' })).location).match(/requests\/(\d+)/) || [])[1]);
  const c = await signIn(consultant);
  const declined = await c.post(`/tprm/clients/${A.id}/requests/${first}/decline`, { reason: 'Covered by the review due next month', row_version: String((await requestRow(first)).row_version) });
  assert.equal(declined.status, 302);
  assert.match((await s.get(`${portal(A.id)}/requests/${first}`)).text, /Covered by the review due next month/);
  const second = Number((String((await ask(s, A.id, tp, { reason: 'Second incident' })).location).match(/requests\/(\d+)/) || [])[1]);
  assert.ok(second > first);
  const w = await s.post(`${portal(A.id)}/requests/${second}/withdraw`, { row_version: String((await requestRow(second)).row_version), _tp_confirmed: '1' });
  assert.equal(w.status, 302);
  assert.equal((await requestRow(second)).status, 'withdrawn');

  const proposed = await supplier(A.id, 'Prospect Co', 'proposed');
  assert.doesNotMatch((await s.get(partyPage(A.id, proposed))).text, /data-tprm-cv-reassess-form/);
  assert.match(said(await ask(s, A.id, proposed, { reason: 'Please' })), /Only a third party in use/);
});

test('contributors, other clients, firm users and other firms are refused', async () => {
  const tp = await supplier(A.id, 'Guarded Co');
  const contributor = await signIn(A.contributor);
  assert.doesNotMatch((await contributor.get(partyPage(A.id, tp))).text, /data-tprm-cv-reassess-form/);
  assert.equal((await ask(contributor, A.id, tp, { reason: 'Contributor asks' })).status, 403);
  const other = await signIn(B.owner);
  assert.equal((await ask(other, A.id, tp, { reason: 'Other client asks' })).status, 403);
  assert.equal((await ask(other, B.id, tp, { reason: 'Through my own client' })).status, 404);
  assert.equal((await ask(client, A.id, tp, { reason: 'Firm manager asks' })).status, 404);
  assert.equal((await requestsFor(tp)).length, 0);

  const owner = await signIn(A.owner);
  const rid = Number((String((await ask(owner, A.id, tp, { reason: 'Real request' })).location).match(/requests\/(\d+)/) || [])[1]);
  const version = String((await requestRow(rid)).row_version);
  assert.equal((await (await signIn(outsider)).post(`/tprm/clients/${A.id}/requests/${rid}/accept`, { row_version: version })).status, 404);
  assert.ok([403, 404].includes((await owner.post(`/tprm/clients/${A.id}/requests/${rid}/accept`, { row_version: version })).status));
  assert.equal((await other.get(`${portal(B.id)}/requests/${rid}`)).status, 404);
  assert.equal((await requestRow(rid)).status, 'submitted');
});

test('a consultant limited to their own suppliers does not see reassessment requests for other suppliers', async () => {
  const tp = await supplier(A.id, 'Hidden Co');
  const owner = await signIn(A.owner);
  const rid = Number((String((await ask(owner, A.id, tp, { reason: 'Hidden reason' })).location).match(/requests\/(\d+)/) || [])[1]);
  const newSupplier = Number((await db.prepare(`INSERT INTO tp_client_requests (workspace_id, name, service_description, requested_by)
    VALUES (?, 'Brand New Co', 'Cleaning', ?) RETURNING id`).get(A.id, A.owner.id)).id);
  const limited = await makeUser('rr-limited@test.local', { workspaceId: A.id, memberRole: 'consultant' });
  const had = await db.prepare('SELECT 1 FROM tp_firm_settings WHERE firm_id=?').get(firmId);
  if (had) await db.prepare('UPDATE tp_firm_settings SET consultants_own_only = true WHERE firm_id=?').run(firmId);
  else await db.prepare('INSERT INTO tp_firm_settings (firm_id, consultants_own_only) VALUES (?, true)').run(firmId);
  try {
    const s = await signIn(limited);
    const home = await s.get(`/tprm/clients/${A.id}`);
    assert.equal(home.status, 200);
    assert.doesNotMatch(home.text, new RegExp(`data-tprm-client-request="${rid}"`));
    assert.match(home.text, new RegExp(`data-tprm-client-request="${newSupplier}"`), 'new-supplier requests stay visible');
    assert.doesNotMatch((await s.get('/tprm')).text, /Hidden Co/);
    assert.equal((await s.get(`/tprm/clients/${A.id}/requests/${rid}`)).status, 404);
    const version = String((await requestRow(rid)).row_version);
    assert.equal((await s.post(`/tprm/clients/${A.id}/requests/${rid}/accept`, { row_version: version })).status, 404);
    assert.equal((await s.post(`/tprm/clients/${A.id}/requests/${rid}/decline`, { row_version: version, reason: 'No' })).status, 404);
    assert.equal((await requestRow(rid)).status, 'submitted');
    assert.match((await (await signIn(consultant)).get(`/tprm/clients/${A.id}`)).text, new RegExp(`data-tprm-client-request="${rid}"`));
  } finally {
    await db.prepare('UPDATE tp_firm_settings SET consultants_own_only = false WHERE firm_id=?').run(firmId);
  }
});

test('the inbox and client status of a limited consultant name only their own suppliers\' reassessment requests', async () => {
  const C = await tprmClient('Reassess Inbox Client', { frameworks: '[]' });
  const limited = await makeUser('rr-inbox-limited@test.local', { workspaceId: C.id, memberRole: 'consultant' });
  const mine = await supplier(C.id, 'Owned Inbox Co');
  const hidden = await supplier(C.id, 'Secret Inbox Co');
  await db.prepare('UPDATE tp_third_parties SET team_owner_id = ? WHERE id = ?').run(limited.id, mine);
  const owner = await signIn(C.owner);
  assert.equal((await owner.get(partyPage(C.id, mine))).status, 200);
  for (const tp of [mine, hidden]) assert.equal((await ask(owner, C.id, tp, { reason: 'Breach reported' })).status, 302);
  assert.equal((await requestsFor(hidden)).length, 1);
  const had = await db.prepare('SELECT 1 FROM tp_firm_settings WHERE firm_id=?').get(firmId);
  if (had) await db.prepare('UPDATE tp_firm_settings SET consultants_own_only = true WHERE firm_id=?').run(firmId);
  else await db.prepare('INSERT INTO tp_firm_settings (firm_id, consultants_own_only) VALUES (?, true)').run(firmId);
  try {
    const s = await signIn(limited);
    const inbox = await s.get(`/workspaces/${C.id}/inbox`);
    assert.equal(inbox.status, 200);
    assert.doesNotMatch(inbox.text, /Secret Inbox Co/);
    assert.match(inbox.text, /Reassess at the client(&#39;|')s request: Owned Inbox Co/);
    assert.doesNotMatch(inbox.text, /Add the client(&#39;|')s request: Owned Inbox Co/);
    const shell = require('../lib/tprm/shell');
    const mixed = shell.statusOf({ parties: [], assessments: [], questionnaires: [], conditions: [],
      requests: [{ id: 1, workspace_id: C.id, kind: 'reassessment', name: 'X' }, { id: 2, workspace_id: C.id, kind: 'new_supplier', name: 'Y' }] }, C.id, ymd(0));
    assert.deepEqual(mixed.reasons, ['1 client request to add', '1 reassessment asked for by the client']);
    assert.deepEqual([mixed.requestsToAdd, mixed.requestsToReassess], [1, 1], 'a reassessment request is not counted as a request to add');
    const full = await (await signIn(consultant)).get(`/workspaces/${C.id}/inbox`);
    assert.match(full.text, /Secret Inbox Co/);
  } finally {
    await db.prepare('UPDATE tp_firm_settings SET consultants_own_only = false WHERE firm_id=?').run(firmId);
  }
});

test('the consultants are emailed about a reassessment request, in reassessment words, and only those who can see the supplier', async () => {
  const was = process.env.EMAIL_DELIVERY_DISABLED;
  process.env.EMAIL_DELIVERY_DISABLED = '0';
  const D = await tprmClient('Reassess Email Client');
  const limited = await makeUser('rr-email-limited@test.local', { workspaceId: D.id, memberRole: 'consultant' });
  const tp = await supplier(D.id, 'Breached Co');
  const had = await db.prepare('SELECT 1 FROM tp_firm_settings WHERE firm_id=?').get(firmId);
  if (had) await db.prepare('UPDATE tp_firm_settings SET consultants_own_only = true WHERE firm_id=?').run(firmId);
  else await db.prepare('INSERT INTO tp_firm_settings (firm_id, consultants_own_only) VALUES (?, true)').run(firmId);
  try {
    const owner = await signIn(D.owner);
    assert.equal((await owner.get(partyPage(D.id, tp))).status, 200);
    const res = await ask(owner, D.id, tp, { reason: 'They reported a breach last week', preferred_date: ymd(14) });
    assert.equal(res.status, 302);
    const rid = Number((String(res.location).match(/requests\/(\d+)/) || [])[1]);
    const rows = await db.prepare(`SELECT * FROM email_outbox WHERE workspace_id=? AND related_type='tprm:consultant_client_request' ORDER BY id`).all(D.id);
    assert.deepEqual(rows.map(r => r.to_email), [consultant.email], 'the consultant who can see the supplier is emailed, the limited one is not');
    assert.equal(rows[0].subject, '[Reassess Email Client] Request to reassess Breached Co');
    assert.match(rows[0].body_text, /asked for Breached Co to be reassessed/);
    assert.match(rows[0].body_text, /They reported a breach last week/);
    assert.match(rows[0].body_text, /Start the reassessment/);
    assert.doesNotMatch(rows[0].body_text, /added as a third party|new supplier/);
    assert.match(rows[0].body_text, new RegExp(`/tprm/clients/${D.id}/requests/${rid}`));
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM email_outbox WHERE lower(to_email)=lower(?)').get(limited.email)).n), 0);
  } finally {
    await db.prepare('UPDATE tp_firm_settings SET consultants_own_only = false WHERE firm_id=?').run(firmId);
    process.env.EMAIL_DELIVERY_DISABLED = was;
  }
});

test('a reassessment request reaches the team when the lead consultant cannot see the supplier', async () => {
  const was = process.env.EMAIL_DELIVERY_DISABLED;
  process.env.EMAIL_DELIVERY_DISABLED = '0';
  const D = await tprmClient('Reassess Lead Scope Client');
  const lead = await makeUser('rr-lead-limited@test.local', { workspaceId: D.id, memberRole: 'consultant' });
  await db.prepare('UPDATE workspaces SET lead_consultant_id=? WHERE id=?').run(lead.id, D.id);
  const tp = await supplier(D.id, 'Hidden From Lead Co');
  const had = await db.prepare('SELECT 1 FROM tp_firm_settings WHERE firm_id=?').get(firmId);
  if (had) await db.prepare('UPDATE tp_firm_settings SET consultants_own_only = true WHERE firm_id=?').run(firmId);
  else await db.prepare('INSERT INTO tp_firm_settings (firm_id, consultants_own_only) VALUES (?, true)').run(firmId);
  try {
    const owner = await signIn(D.owner);
    assert.equal((await owner.get(partyPage(D.id, tp))).status, 200);
    const res = await ask(owner, D.id, tp, { reason: 'They moved data centres' });
    assert.equal(res.status, 302);
    const rows = await db.prepare(`SELECT to_email FROM email_outbox WHERE workspace_id=? AND related_type='tprm:consultant_client_request' ORDER BY id`).all(D.id);
    assert.deepEqual(rows.map(r => r.to_email), [consultant.email], 'the team member who can see the supplier is emailed instead of nobody');
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM email_outbox WHERE lower(to_email)=lower(?)').get(lead.email)).n), 0);
  } finally {
    await db.prepare('UPDATE tp_firm_settings SET consultants_own_only = false WHERE firm_id=?').run(firmId);
    process.env.EMAIL_DELIVERY_DISABLED = was;
  }
});

test('a supplier never assessed is asked for an assessment: the form error and the request page say assessment, and the home counts it apart from one assessed before', async () => {
  const D = await tprmClient('Assess First Client');
  const before = await supplier(D.id, 'Assessed Before Co');
  const fresh = await supplier(D.id, 'Never Assessed Co');
  await db.prepare(`UPDATE tp_third_parties SET last_assessment_date=NULL, next_due_date=NULL, current_tier='critical', tier_source='provisional_from_client_label' WHERE id=?`).run(fresh);
  const owner = await signIn(D.owner);
  const home = (await owner.get(portal(D.id))).text;
  assert.match(home, /data-tprm-cv-not-assessed>Not assessed yet<b>1<\/b>/, 'only the supplier never assessed is not assessed yet');
  assert.match(home, /data-tprm-cv-assessed-no-decision>Assessed, no decision recorded<b>1<\/b>/);
  const row = home.slice(home.indexOf(`data-tprm-portal-row="${fresh}"`), home.indexOf('</tr>', home.indexOf(`data-tprm-portal-row="${fresh}"`)));
  assert.match(row, /Critical \(provisional\)<\/span>/, 'the tier reads as on the supplier page');
  assert.ok(before);
  assert.equal((await owner.get(partyPage(D.id, fresh))).status, 200);
  const empty = await ask(owner, D.id, fresh, { reason: '' });
  assert.equal(empty.status, 400);
  assert.match(empty.text, /Why you want it assessed is required/);
  assert.doesNotMatch(empty.text, /reassessed is required/);
  const res = await ask(owner, D.id, fresh, { reason: 'We now send them card data' });
  assert.equal(res.status, 302);
  const view = (await owner.get(String(res.location).split('?')[0])).text;
  assert.match(view, /Assessment of Never Assessed Co/);
  assert.doesNotMatch(view, /Reassessment of Never Assessed Co/);
  assert.match(view, /Your consultants start the assessment or tell you why not/);
});

test('a client request reaches the team when the lead consultant has turned email off', async () => {
  const was = process.env.EMAIL_DELIVERY_DISABLED;
  process.env.EMAIL_DELIVERY_DISABLED = '0';
  const D = await tprmClient('Reassess Lead Muted Client');
  const lead = await makeUser('rr-lead-muted@test.local', { workspaceId: D.id, memberRole: 'consultant' });
  await db.prepare("UPDATE users SET email_notify='off' WHERE id=?").run(lead.id);
  await db.prepare('UPDATE workspaces SET lead_consultant_id=? WHERE id=?').run(lead.id, D.id);
  const tp = await supplier(D.id, 'Muted Lead Co');
  try {
    const owner = await signIn(D.owner);
    assert.equal((await owner.get(partyPage(D.id, tp))).status, 200);
    assert.equal((await ask(owner, D.id, tp, { reason: 'New data flows' })).status, 302);
    const rows = await db.prepare(`SELECT to_email FROM email_outbox WHERE workspace_id=? AND related_type='tprm:consultant_client_request' ORDER BY id`).all(D.id);
    assert.deepEqual(rows.map(r => r.to_email), [consultant.email], 'the team is emailed instead of nobody');
  } finally {
    process.env.EMAIL_DELIVERY_DISABLED = was;
  }
});
