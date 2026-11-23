'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient, allSteps } = require('./helpers');

let env;
let client;
let db;
let firmId;
let managerId;
let ev;
let fd;
let events;
let rbac;
let consultant;

const PASSWORD = 'evidence-tests-password-1234';
const ROOT = path.join(__dirname, '..');
const createdPaths = new Set();
const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  ev = require('../lib/tprm/evidence');
  fd = require('../lib/tprm/findings');
  events = require('../lib/tprm/events');
  rbac = require('../lib/rbac');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
  consultant = await makeUser('evidence-consultant@test.local', { role: 'consultant' });
  consultant.session = await signIn(consultant.email, consultant.password);
});

test.after(async () => {
  for (const p of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  if (consultant && consultant.session) await consultant.session.close();
  if (client) await client.close();
});

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId, workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firm : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email, password: PASSWORD, firm_id: firm, firm_role: role, user_type: type };
}

async function signIn(email, password) {
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${email} signs in`);
  await session.get('/dashboard');
  return session;
}

async function tprmClient(name, { firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,?,'certification_support')`).run(firm, name, JSON.stringify(['iso27001']))).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (firm === firmId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, consultant.id, 'consultant');
  return id;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const sha = text => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const unique = prefix => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
const evidenceRow = async id => db.prepare('SELECT * FROM tp_evidence WHERE id=?').get(id);
const findingRow = async id => db.prepare('SELECT * FROM tp_findings WHERE id=?').get(id);
const storedFile = (stored, firm = firmId) => path.join(ROOT, 'uploads', `firm_${firm}`, stored);
const actions = async a => (await db.prepare(`SELECT action FROM tp_events WHERE chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(a)).map(r => r.action);

async function assessmentFor(ws, name = 'Acme', session = client) {
  const res = await session.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
  assert.equal(res.status, 302, `create redirects (got ${res.status})`);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await session.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Payroll processing' })).status, 302);
  const started = await session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302);
  return { ws, tp, a: idIn(started.location, /assessments\/(\d+)/) };
}

function multipart(token, files, fields = {}) {
  const boundary = '----tprmev' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (token) parts.push(`--${boundary}`, 'Content-Disposition: form-data; name="_csrf"', '', token);
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', v);
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="files"; filename="${f.filename}"`,
      `Content-Type: ${f.type || 'application/octet-stream'}`, '', f.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(session, { ws, tp, a }, files, { token, fields } = {}) {
  const form = multipart(token === undefined ? session.getCsrfToken() : token, files, fields);
  const res = await session.post(`${aBase(ws, tp, a)}/evidence`, form.body, { headers: form.headers });
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence WHERE workspace_id=?').all(ws)) createdPaths.add(r.stored_path);
  return res;
}

async function uploadOne(session, target, filename, content) {
  const res = await upload(session, target, [{ filename, content, type: 'text/plain' }]);
  assert.equal(res.status, 302, `upload redirects (got ${res.status}: ${(res.text || '').slice(0, 200)})`);
  const row = await db.prepare('SELECT * FROM tp_evidence WHERE workspace_id=? AND assessment_id=? AND original_name=?')
    .get(target.ws, target.a, filename);
  assert.ok(row, `${filename} stored`);
  return row;
}

function stagedFor(name) {
  const dir = path.join(ROOT, 'uploads', `firm_${firmId}`);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(name.replace(/[^\w.-]/g, '_'))) : [];
}

async function wsRow(id) {
  return await db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
}

async function managerActor(ws) {
  return { user: { id: managerId, user_type: 'firm', firm_id: firmId, firm_role: 'manager' },
    perms: new Set(rbac.rolePermissions('manager').concat(['*'])), ws: await wsRow(ws) };
}

test('uploading several files stores each once with the sha256 of its bytes, and the page never shows a storage path', async () => {
  const target = await assessmentFor(await tprmClient('Evidence Upload Client'));
  const notes = `Access review notes ${unique('n')}\n`;
  const report = `${PDF}% ${unique('r')}\n`;
  const res = await upload(client, target, [
    { filename: 'access-review.txt', content: notes, type: 'text/plain' },
    { filename: 'soc2-report.pdf', content: report, type: 'application/pdf' },
  ], { fields: { description: 'Sent by the third party' } });
  assert.equal(res.status, 302, (res.text || '').slice(0, 300));
  assert.match(decodeURIComponent(res.location), /2 files uploaded/);
  const rows = await db.prepare('SELECT * FROM tp_evidence WHERE assessment_id=? ORDER BY id').all(target.a);
  assert.deepEqual(rows.map(r => r.original_name), ['access-review.txt', 'soc2-report.pdf']);
  assert.equal(rows[0].sha256, sha(notes));
  assert.equal(rows[1].sha256, sha(report));
  assert.equal(Number(rows[1].size_bytes), Buffer.byteLength(report));
  for (const r of rows) {
    assert.equal(r.source, 'consultant');
    assert.equal(r.released_to_client, false);
    assert.equal(r.description, 'Sent by the third party');
    assert.equal(Number(r.uploaded_by), managerId);
    const onDisk = fs.readFileSync(storedFile(r.stored_path));
    assert.equal(crypto.createHash('sha256').update(onDisk).digest('hex'), r.sha256, 'the stored bytes match the recorded sha256');
  }
  assert.deepEqual(await actions(target.a), ['assessment.started', 'evidence.uploaded', 'evidence.uploaded']);
  const event = await db.prepare(`SELECT after_state FROM tp_events WHERE chain_id=? AND action='evidence.uploaded' ORDER BY chain_seq LIMIT 1`).get(target.a);
  assert.equal(event.after_state.sha256, sha(notes));
  assert.equal(event.after_state.stored_path, undefined, 'events carry no storage path');

  const again = await upload(client, target, [{ filename: 'copy-of-notes.txt', content: notes, type: 'text/plain' }]);
  assert.equal(again.status, 302);
  assert.match(decodeURIComponent(again.location), /already on this assessment/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_evidence WHERE assessment_id=?').get(target.a)).c, 2);
  assert.deepEqual(stagedFor('copy-of-notes.txt'), [], 'the skipped copy is removed from storage');

  const page = await allSteps(client, aBase(target.ws, target.tp, target.a));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-evidence/);
  assert.match(page.text, /access-review\.txt/);
  assert.match(page.text, /data-tprm-history-action="evidence.uploaded"/, 'History shows the event');
  for (const r of rows) assert.ok(!page.text.includes(r.stored_path), 'the page does not contain the storage path');
  assert.doesNotMatch(page.text, /uploads\/firm_/);
});

test('upload validation: file type, contents, size and count use the app\'s upload pipeline; nothing is staged on refusal', async () => {
  const target = await assessmentFor(await tprmClient('Evidence Validation Client'));
  const exe = `${unique('payload')}.exe`;
  const badType = await upload(client, target, [{ filename: exe, content: 'MZ\u0000binary' }]);
  assert.equal(badType.status, 400);
  assert.match(badType.text, /This file type is not allowed/);
  const fakePdf = `${unique('fake')}.pdf`;
  const badSignature = await upload(client, target, [{ filename: fakePdf, content: 'not really a pdf' }]);
  assert.equal(badSignature.status, 400);
  assert.match(badSignature.text, /do not match its extension/);
  const big = `${unique('big')}.txt`;
  const tooBig = await upload(client, target, [{ filename: big, content: 'a'.repeat(50 * 1024 * 1024 + 1), type: 'text/plain' }]);
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.text, /larger than the 50 MB limit/);
  const many = Array.from({ length: ev.LIMITS.filesPerUpload + 1 }, (_, i) => ({ filename: `many-${i}-${unique('m')}.txt`, content: `file ${i}`, type: 'text/plain' }));
  const tooMany = await upload(client, target, many);
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.text, /at most 20 files/);
  const none = await upload(client, target, []);
  assert.equal(none.status, 400);
  assert.match(none.text, /Choose at least one file/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_evidence WHERE assessment_id=?').get(target.a)).c, 0);
  for (const name of [exe, fakePdf, big, ...many.map(m => m.filename)]) assert.deepEqual(stagedFor(name), [], `${name} is not left in storage`);
  assert.deepEqual(await actions(target.a), ['assessment.started']);
});

test('download: firm users with access only; another client, firm or a client user gets 404', async () => {
  const ws = await tprmClient('Evidence Download Client');
  const otherWs = await tprmClient('Evidence Download Other Client');
  const target = await assessmentFor(ws, 'Download Co');
  const other = await assessmentFor(otherWs, 'Other Download Co');
  const content = `Pen test summary ${unique('p')}\n`;
  const row = await uploadOne(client, target, 'pentest-summary.txt', content);
  const url = `${aBase(ws, target.tp, target.a)}/evidence/${row.id}/download`;

  const ok = await client.get(url);
  assert.equal(ok.status, 200);
  assert.equal(ok.text, content);
  assert.match(ok.headers['content-disposition'], /attachment; filename="pentest-summary\.txt"/);
  assert.equal((await consultant.session.get(url)).status, 200, 'an assigned consultant can download');
  const notInline = await client.get(`${url}?inline=1`);
  assert.match(notInline.headers['content-disposition'], /^attachment;/, 'a text file is never shown inline');
  const pdfForm = multipart(client.getCsrfToken(), [{ filename: 'scope-letter.pdf', content: PDF, type: 'application/pdf' }]);
  assert.equal((await client.post(`${aBase(ws, target.tp, target.a)}/evidence`, pdfForm.body, { headers: pdfForm.headers })).status, 302);
  const pdfRow = await db.prepare("SELECT * FROM tp_evidence WHERE workspace_id=? AND original_name='scope-letter.pdf'").get(ws);
  createdPaths.add(pdfRow.stored_path);
  const inline = await client.get(`${aBase(ws, target.tp, target.a)}/evidence/${pdfRow.id}/download?inline=1`);
  assert.equal(inline.status, 200);
  assert.match(inline.headers['content-type'], /^application\/pdf/);
  assert.match(inline.headers['content-disposition'], /^inline; filename\*=UTF-8''scope-letter\.pdf/);
  assert.equal(inline.headers['x-content-type-options'], 'nosniff');
  const page = await client.get(aBase(ws, target.tp, target.a) + '?step=evidence');
  assert.match(page.text, new RegExp(`data-tp-preview="[^"]*/evidence/${pdfRow.id}/download\\?inline=1"`));
  assert.doesNotMatch(page.text, new RegExp(`data-tp-preview="[^"]*/evidence/${row.id}/download`), 'no preview link for a text file');

  for (const wrong of [
    `${aBase(otherWs, target.tp, target.a)}/evidence/${row.id}/download`,
    `${aBase(otherWs, other.tp, other.a)}/evidence/${row.id}/download`,
    `${aBase(ws, target.tp, target.a)}/evidence/${row.id + 100000}/download`,
    `${aBase(ws, other.tp, target.a)}/evidence/${row.id}/download`,
  ]) assert.equal((await client.get(wrong)).status, 404, wrong);

  const otherFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Evidence Other Firm')").run()).lastInsertRowid);
  const outsider = await makeUser('evidence-other-firm@test.local', { role: 'manager', firm: otherFirm });
  const unassigned = await makeUser('evidence-unassigned@test.local', { role: 'consultant' });
  const owner = await makeUser('evidence-client-owner@test.local', { type: 'client', workspaceId: ws, memberRole: 'client_owner' });
  for (const user of [outsider, unassigned, owner]) {
    const session = await signIn(user.email, user.password);
    try {
      const res = await session.get(url);
      assert.equal(res.status, 404, `${user.email} gets 404`);
      assert.ok(!res.text.includes(content), 'and never the file');
      const form = multipart(session.getCsrfToken(), [{ filename: `${unique('intruder')}.txt`, content: 'x', type: 'text/plain' }]);
      assert.equal((await session.post(`${aBase(ws, target.tp, target.a)}/evidence`, form.body, { headers: form.headers })).status, 404);
      assert.equal((await session.post(`${aBase(ws, target.tp, target.a)}/evidence/${row.id}/release`, { row_version: '1' })).status, 404);
      assert.equal((await session.post(`${aBase(ws, target.tp, target.a)}/evidence/${row.id}/delete`, { row_version: '1' })).status, 404);
    } finally {
      await session.close();
    }
  }
  await ev.releaseEvidence(db, await managerActor(ws), target.tp, target.a, row.id, { row_version: String(row.row_version) });
  const ownerSession = await signIn(owner.email, owner.password);
  try {
    assert.equal((await ownerSession.get(url)).status, 404, 'a client user cannot download a released file here either');
  } finally {
    await ownerSession.close();
  }
  await assert.rejects(ev.evidenceFile(db, { user: { id: owner.id, user_type: 'client' }, perms: new Set(['tp.view']), ws: await wsRow(ws) },
    target.tp, target.a, row.id), err => err.status === 404);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_evidence WHERE assessment_id=?').get(target.a)).c, 2, 'the text file and the PDF of the preview check, nothing else');
});

test('release is file by file and one-way; a released file cannot be deleted (route, domain, database)', async () => {
  const ws = await tprmClient('Evidence Release Client');
  const target = await assessmentFor(ws, 'Release Co');
  const keep = await uploadOne(client, target, 'iso-certificate.txt', `Certificate ${unique('c')}`);
  const internal = await uploadOne(client, target, 'internal-notes.txt', `Notes ${unique('n')}`);
  const base = aBase(ws, target.tp, target.a);

  assert.equal((await client.post(`${base}/evidence/${keep.id}/release`, { row_version: String(keep.row_version + 1) })).status, 409, 'stale row_version');
  const released = await client.post(`${base}/evidence/${keep.id}/release`, { row_version: String(keep.row_version) });
  assert.equal(released.status, 302);
  const row = await evidenceRow(keep.id);
  assert.equal(row.released_to_client, true);
  assert.equal(Number(row.released_by), managerId);
  assert.ok(row.released_at);
  assert.equal((await evidenceRow(internal.id)).released_to_client, false, 'only that file is released');
  assert.equal((await client.post(`${base}/evidence/${keep.id}/release`, { row_version: String(row.row_version) })).status, 302, 'releasing again is harmless');
  assert.equal((await actions(target.a)).filter(x => x === 'evidence.released').length, 1, 'and records one release');

  const page = await client.get(`${base}?step=evidence`);
  assert.match(page.text, new RegExp(`data-tprm-evidence-row="${keep.id}"[\\s\\S]*?data-tprm-released`));
  assert.doesNotMatch(page.text.slice(page.text.indexOf(`data-tprm-evidence-row="${keep.id}"`), page.text.indexOf(`data-tprm-evidence-row="${internal.id}"`)),
    /data-tprm-delete/, 'no delete button on a released file');

  const refused = await client.post(`${base}/evidence/${keep.id}/delete`, { row_version: String(row.row_version) });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /released to the client, so it cannot be deleted/);
  assert.ok(await evidenceRow(keep.id), 'the row stays');
  assert.ok(fs.existsSync(storedFile(row.stored_path)), 'and so does the file');
  await assert.rejects(ev.deleteEvidence(db, await managerActor(ws), target.tp, target.a, keep.id, { row_version: String(row.row_version) }),
    err => err.status === 409);
  await assert.rejects(db.prepare('DELETE FROM tp_evidence WHERE id=?').run(keep.id), /released to the client cannot be deleted/);
  await assert.rejects(db.prepare('UPDATE tp_evidence SET released_to_client=false, released_by=NULL, released_at=NULL WHERE id=?').run(keep.id),
    /cannot be withdrawn/);
  await assert.rejects(db.prepare("UPDATE tp_evidence SET sha256=repeat('a', 64) WHERE id=?").run(internal.id), /cannot be changed/);
  await assert.rejects(db.prepare("UPDATE tp_evidence SET stored_path='other.txt' WHERE id=?").run(internal.id), /cannot be changed/);

  const list = await ev.listReleasedEvidence(db, await wsRow(ws), target.a);
  assert.deepEqual(list.map(r => Number(r.id)), [Number(keep.id)]);
  assert.equal(list[0].stored_path, undefined);
  assert.equal(list[0].sha256, keep.sha256);
  assert.deepEqual(await ev.listReleasedEvidence(db, await tprmClient('Evidence Release Elsewhere'), target.a), [], 'another workspace sees nothing');
});

test('deleting an unreleased file removes the row and the stored file and records the event', async () => {
  const ws = await tprmClient('Evidence Delete Client');
  const target = await assessmentFor(ws, 'Delete Co');
  const row = await uploadOne(consultant.session, target, 'draft-questionnaire.txt', `Draft ${unique('d')}`);
  const base = aBase(ws, target.tp, target.a);
  assert.ok(fs.existsSync(storedFile(row.stored_path)));
  assert.equal((await consultant.session.post(`${base}/evidence/${row.id}/delete`, { row_version: '99' })).status, 409, 'stale row_version');
  const res = await consultant.session.post(`${base}/evidence/${row.id}/delete`, { row_version: String(row.row_version) });
  assert.equal(res.status, 302);
  assert.equal(await evidenceRow(row.id), undefined);
  assert.equal(fs.existsSync(storedFile(row.stored_path)), false, 'the stored file is removed');
  const event = await db.prepare(`SELECT actor_user_id, before_state FROM tp_events WHERE chain_id=? AND action='evidence.deleted'`).get(target.a);
  assert.equal(Number(event.actor_user_id), consultant.id);
  assert.equal(event.before_state.name, 'draft-questionnaire.txt');
  assert.equal(event.before_state.sha256, row.sha256);
  assert.equal((await client.post(`${base}/evidence/${row.id}/delete`, { row_version: '1' })).status, 404, 'gone');
  const viewer = { user: { id: consultant.id, user_type: 'firm', firm_id: firmId, firm_role: 'consultant' }, perms: new Set(['tp.view']), ws: await wsRow(ws) };
  await assert.rejects(ev.addEvidence(db, viewer, target.tp, target.a, [{ path: __filename, originalname: 'x.txt', filename: 'x.txt', size: 1 }]),
    err => err.status === 403);
});

test('findings: add, edit and remove, citing files of the same assessment only', async () => {
  const ws = await tprmClient('Findings Client');
  const otherWs = await tprmClient('Findings Other Client');
  const target = await assessmentFor(ws, 'Findings Co');
  const sibling = await assessmentFor(ws, 'Sibling Co');
  const elsewhere = await assessmentFor(otherWs, 'Elsewhere Co');
  const policy = await uploadOne(client, target, 'access-policy.txt', `Policy ${unique('p')}`);
  const log = await uploadOne(client, target, 'access-log.txt', `Log ${unique('l')}`);
  const siblingFile = await uploadOne(client, sibling, 'sibling.txt', `Sibling ${unique('s')}`);
  const elsewhereFile = await uploadOne(client, elsewhere, 'elsewhere.txt', `Elsewhere ${unique('e')}`);
  const base = aBase(ws, target.tp, target.a);

  assert.equal((await client.get(`${base}/findings/new`)).status, 200);
  const invalid = await client.post(`${base}/findings`, { severity: 'severe', title: '', control_ref: 'A'.repeat(41) });
  assert.equal(invalid.status, 400);
  assert.match(invalid.text, /Choose a severity/);
  assert.match(invalid.text, /Give the finding a title/);
  assert.match(invalid.text, /control reference must be 40 characters/);

  for (const foreign of [siblingFile, elsewhereFile]) {
    const res = await client.post(`${base}/findings`, { severity: 'high', title: 'Cites a foreign file', evidence: [String(policy.id), String(foreign.id)] });
    assert.equal(res.status, 400, `file ${foreign.original_name} is refused`);
    assert.match(res.text, /not part of this assessment/);
  }
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_findings WHERE assessment_id=?').get(target.a)).c, 0);

  const added = await client.post(`${base}/findings`, {
    control_ref: 'A.5.20', severity: 'high', title: 'No supplier access review',
    description: 'Access is not reviewed quarterly.', evidence: [String(policy.id), String(log.id)],
  });
  assert.equal(added.status, 302, (added.text || '').slice(0, 300));
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=?').get(target.a);
  assert.equal(finding.control_ref, 'A.5.20');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.status, 'open');
  assert.equal(finding.source, 'consultant');
  assert.equal(Number(finding.created_by), managerId);
  const links = async id => (await db.prepare('SELECT evidence_id FROM tp_finding_evidence WHERE finding_id=? ORDER BY evidence_id').all(id)).map(r => Number(r.evidence_id));
  assert.deepEqual(await links(finding.id), [Number(policy.id), Number(log.id)]);

  await assert.rejects(db.prepare('INSERT INTO tp_finding_evidence (workspace_id, assessment_id, finding_id, evidence_id) VALUES (?, ?, ?, ?)')
    .run(ws, target.a, finding.id, siblingFile.id), /foreign key/);
  await assert.rejects(db.prepare('INSERT INTO tp_finding_evidence (workspace_id, assessment_id, finding_id, evidence_id) VALUES (?, ?, ?, ?)')
    .run(ws, sibling.a, finding.id, siblingFile.id), /foreign key/);
  await assert.rejects(db.prepare('INSERT INTO tp_finding_evidence (workspace_id, assessment_id, finding_id, evidence_id) VALUES (?, ?, ?, ?)')
    .run(otherWs, elsewhere.a, finding.id, elsewhereFile.id), /foreign key/);

  const cited = await client.post(`${base}/evidence/${log.id}/delete`, { row_version: String(log.row_version) });
  assert.equal(cited.status, 409);
  assert.match(cited.text, /cited by the finding/);

  const page = await allSteps(client, base);
  assert.match(page.text, /No supplier access review/);
  assert.match(page.text, /A\.5\.20/);
  assert.match(page.text, /data-tprm-history-action="finding.added"/, 'History shows the event');
  assert.equal((await client.get(`${base}/findings/${finding.id}/edit`)).status, 200);
  assert.equal((await client.get(`${aBase(otherWs, elsewhere.tp, elsewhere.a)}/findings/${finding.id}/edit`)).status, 404, 'another client\'s URL');

  const edit = body => client.post(`${base}/findings/${finding.id}`, {
    control_ref: 'A.5.20', severity: 'critical', title: 'No supplier access review', description: 'Access is never reviewed.',
    status: 'closed', evidence: [String(policy.id)], ...body,
  });
  assert.equal((await edit({ row_version: String(finding.row_version + 1) })).status, 409, 'stale row_version');
  assert.equal((await edit({ row_version: String(finding.row_version), evidence: [String(elsewhereFile.id)] })).status, 400, 'cross-client link on edit');
  assert.equal((await edit({ row_version: String(finding.row_version) })).status, 302);
  const edited = await findingRow(finding.id);
  assert.equal(edited.severity, 'critical');
  assert.equal(edited.status, 'closed');
  assert.equal(edited.row_version, finding.row_version + 1);
  assert.deepEqual(await links(finding.id), [Number(policy.id)]);
  const update = await db.prepare(`SELECT before_state, after_state FROM tp_events WHERE chain_id=? AND action='finding.updated'`).get(target.a);
  assert.deepEqual(update.before_state, { finding_id: Number(finding.id), severity: 'high', description: 'Access is not reviewed quarterly.', status: 'open',
    evidence_ids: [Number(policy.id), Number(log.id)] });
  assert.deepEqual(update.after_state, { finding_id: Number(finding.id), severity: 'critical', description: 'Access is never reviewed.', status: 'closed',
    evidence_ids: [Number(policy.id)] });

  assert.equal((await client.post(`${base}/evidence/${log.id}/delete`, { row_version: String(log.row_version) })).status, 302);

  assert.equal((await client.post(`${base}/findings/${finding.id}/remove`, { row_version: String(finding.row_version) })).status, 409, 'stale row_version');
  assert.equal((await client.post(`${base}/findings/${finding.id}/remove`, { row_version: String(edited.row_version) })).status, 302);
  assert.equal(await findingRow(finding.id), undefined);
  assert.deepEqual(await links(finding.id), []);
  assert.ok(await evidenceRow(policy.id), 'removing a finding keeps its files');
  assert.deepEqual((await actions(target.a)).filter(x => x.startsWith('finding.')), ['finding.added', 'finding.updated', 'finding.removed']);
  assert.deepEqual(await events.verifyChains(db, ws), [], 'every chain of the client verifies');
});

test('a cancelled assessment refuses every evidence and finding change', async () => {
  const ws = await tprmClient('Evidence Closed Client');
  const target = await assessmentFor(ws, 'Closed Co');
  const file = await uploadOne(client, target, 'before-cancel.txt', `Before ${unique('b')}`);
  const base = aBase(ws, target.tp, target.a);
  assert.equal((await client.post(`${base}/findings`, { severity: 'low', title: 'Minor gap', evidence: [String(file.id)] })).status, 302);
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=?').get(target.a);
  const assessment = await db.prepare('SELECT row_version FROM tp_assessments WHERE id=?').get(target.a);
  assert.equal(assessment.row_version, 1, 'evidence and findings never bump the assessment\'s row_version');
  assert.equal((await client.post(`${base}/cancel`, { row_version: String(assessment.row_version), reason: 'Third party withdrew' })).status, 302);

  const late = `${unique('late')}.txt`;
  const upload1 = await upload(client, target, [{ filename: late, content: 'too late', type: 'text/plain' }]);
  assert.equal(upload1.status, 409);
  assert.match(upload1.text, /cancelled/);
  assert.deepEqual(stagedFor(late), [], 'the refused upload staged nothing');
  assert.equal((await client.post(`${base}/evidence/${file.id}/release`, { row_version: String(file.row_version) })).status, 409);
  assert.equal((await client.post(`${base}/evidence/${file.id}/delete`, { row_version: String(file.row_version) })).status, 409);
  assert.equal((await client.post(`${base}/findings`, { severity: 'low', title: 'Another' })).status, 409);
  assert.equal((await client.get(`${base}/findings/new`)).status, 409);
  assert.equal((await client.post(`${base}/findings/${finding.id}`, { severity: 'high', title: 'Changed', status: 'open', row_version: String(finding.row_version) })).status, 409);
  assert.equal((await client.post(`${base}/findings/${finding.id}/remove`, { row_version: String(finding.row_version) })).status, 409);
  assert.equal((await client.get(`${base}/evidence/${file.id}/download`)).status, 200, 'files stay downloadable');

  const page = await client.get(`${base}?step=evidence`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /data-tprm-upload-form|data-tprm-add-finding|data-tprm-release-form/);
  assert.match(page.text, /Minor gap/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_evidence WHERE assessment_id=?').get(target.a)).c, 1);
  assert.equal((await findingRow(finding.id)).title, 'Minor gap');
});

test('CSRF is required on every evidence and finding form, multipart uploads included', async () => {
  const ws = await tprmClient('Evidence CSRF Client');
  const target = await assessmentFor(ws, 'CSRF Co');
  const file = await uploadOne(client, target, 'csrf-file.txt', `CSRF ${unique('c')}`);
  await client.post(`${aBase(ws, target.tp, target.a)}/findings`, { severity: 'low', title: 'CSRF finding' });
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=?').get(target.a);
  const base = aBase(ws, target.tp, target.a);

  for (const token of [null, 'f'.repeat(64)]) {
    const name = `${unique('csrf')}.txt`;
    const res = await upload(client, target, [{ filename: name, content: 'forged', type: 'text/plain' }], { token });
    assert.equal(res.status, 403, `multipart upload with ${token ? 'a forged' : 'no'} token`);
    assert.deepEqual(stagedFor(name), [], 'the staged file is removed');
  }
  for (const p of [`${base}/evidence/${file.id}/release`, `${base}/evidence/${file.id}/delete`, `${base}/findings`,
    `${base}/findings/${finding.id}`, `${base}/findings/${finding.id}/remove`]) {
    assert.equal((await client.post(p, { row_version: '1', severity: 'low', title: 'x' }, { csrf: false })).status, 403, `${p} without a token`);
    assert.equal((await client.post(p, { row_version: '1', severity: 'low', title: 'x', _csrf: 'f'.repeat(64) }, { csrf: false })).status, 403, `${p} forged`);
  }
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_evidence WHERE assessment_id=?').get(target.a)).c, 1);
  assert.equal((await evidenceRow(file.id)).released_to_client, false);
  assert.equal((await findingRow(finding.id)).row_version, 1);
});

test('deleting a workspace removes its evidence (released too), findings, links and stored files', async () => {
  const ws = await tprmClient('Evidence Deleted Client');
  const target = await assessmentFor(ws, 'Deleted Co');
  const released = await uploadOne(client, target, 'released.txt', `Released ${unique('r')}`);
  const internal = await uploadOne(client, target, 'internal.txt', `Internal ${unique('i')}`);
  await ev.releaseEvidence(db, await managerActor(ws), target.tp, target.a, released.id, { row_version: String(released.row_version) });
  await fd.addFinding(db, await managerActor(ws), target.tp, target.a, { severity: 'medium', title: 'Gap', evidence: [String(released.id), String(internal.id)] });
  const deleted = await client.post(`/workspaces/${ws}/delete`, { confirm_name: 'Evidence Deleted Client' });
  assert.equal(deleted.status, 302);
  assert.match(deleted.location, /^\/dashboard\?/);
  for (const table of ['tp_evidence', 'tp_findings', 'tp_finding_evidence', 'tp_events', 'tp_assessments']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ws)).c, 0, `${table} emptied`);
  }
  for (const r of [released, internal]) assert.equal(fs.existsSync(storedFile(r.stored_path)), false, `${r.original_name} removed from storage`);
  const { immutableMutationTriggers } = require('../lib/workspace-deletion');
  assert.ok((await immutableMutationTriggers(db)).some(t => t.name === 'tp_evidence_guard'), 'the guard is back on after the purge');

  const ws2 = await tprmClient('Evidence Direct Delete Client');
  const target2 = await assessmentFor(ws2, 'Direct Co');
  const file2 = await uploadOne(client, target2, 'direct.txt', `Direct ${unique('d')}`);
  await ev.releaseEvidence(db, await managerActor(ws2), target2.tp, target2.a, file2.id, { row_version: String(file2.row_version) });
  await fd.addFinding(db, await managerActor(ws2), target2.tp, target2.a, { severity: 'low', title: 'Direct gap', evidence: [String(file2.id)] });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(ws2);
  for (const table of ['tp_evidence', 'tp_findings', 'tp_finding_evidence']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ws2)).c, 0, `${table} cascaded`);
  }

  const restoreCheck = fs.readFileSync(path.join(ROOT, 'lib', 'restore-check.js'), 'utf8');
  assert.match(restoreCheck.slice(restoreCheck.indexOf('SNAPSHOT_COUNT_TABLES'), restoreCheck.indexOf('LIVE_COUNT_MIN_RATIO')), /'tp_evidence', 'tp_findings'/,
    'backup verification counts evidence and findings');
  assert.match(restoreCheck, /table: 'tp_evidence', column: 'stored_path'/, 'and checks the evidence files are in the snapshot');
});

test('one confirmation: a confirmable form posted unconfirmed changes nothing and shows the question; confirmed, it acts', async () => {
  const ws = await tprmClient('Evidence Confirm Client');
  const target = await assessmentFor(ws, 'Confirm Co');
  const row = await uploadOne(client, target, 'to-delete.txt', `Delete me ${unique('d')}`);
  const url = `${aBase(ws, target.tp, target.a)}/evidence/${row.id}/delete`;
  const fields = { row_version: String(row.row_version), _tp_confirm_title: 'Delete this file?',
    _tp_confirm_body: 'The file is removed for good. This cannot be undone.', _tp_confirm_action: 'Delete file', _tp_confirm_tone: 'problem' };

  const asked = await client.post(url, { ...fields });
  assert.equal(asked.status, 200);
  assert.match(asked.text, /data-tprm-confirm-page/);
  assert.match(asked.text, /Delete this file\?/);
  assert.match(asked.text, /The file is removed for good\. This cannot be undone\./);
  assert.match(asked.text, new RegExp(`<form method="POST" action="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(asked.text, /name="row_version" value="\d+"/, 'the form\'s own fields are sent again');
  assert.match(asked.text, /name="_tp_confirmed" value="1"/);
  assert.doesNotMatch(asked.text, /name="_tp_confirm_title"/, 'the question is not sent twice');
  assert.ok(await db.prepare('SELECT 1 FROM tp_evidence WHERE id=?').get(row.id), 'nothing deleted yet');

  const done = await client.post(url, { ...fields, _tp_confirmed: '1' });
  assert.equal(done.status, 302);
  assert.equal(await db.prepare('SELECT 1 FROM tp_evidence WHERE id=?').get(row.id), undefined, 'deleted');
  const plain = await uploadOne(client, target, 'plain-delete.txt', `Plain ${unique('p')}`);
  assert.equal((await client.post(`${aBase(ws, target.tp, target.a)}/evidence/${plain.id}/delete`, { row_version: String(plain.row_version) })).status, 302);
});
