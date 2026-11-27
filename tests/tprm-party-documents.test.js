'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'party-docs-tests-password-1234';
const ROOT = path.join(__dirname, '..');
const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';

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
const createdPaths = new Set();

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

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, consultant.id, 'consultant');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`pd-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
  const contributor = await makeUser(`pd-contrib-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'contributor' });
  const s = await signIn(consultant);
  const res = await s.post(`/tprm/clients/${id}/third-parties`, { name: `${name} Supplier`, status: 'in_use' });
  assert.equal(res.status, 302);
  const tp = Number((String(res.location).match(/third-parties\/(\d+)/) || [])[1]);
  return { id, tp, owner, contributor };
}

function multipart(token, file, fields = {}) {
  const boundary = '----tprmpd' + crypto.randomBytes(8).toString('hex');
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

const firmBase = (c) => `/tprm/clients/${c.id}/third-parties/${c.tp}`;
const portalBase = (c) => `/workspaces/${c.id}/client-portal/third-party-risk/third-parties/${c.tp}`;
const ymd = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const said = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const docRow = async (ws, title) => db.prepare('SELECT * FROM tp_party_documents WHERE workspace_id=? AND title=? ORDER BY id DESC LIMIT 1').get(ws, title);

async function file(session, c, fields, fileSpec = { filename: 'cert.pdf', content: `${PDF}% ${crypto.randomBytes(4).toString('hex')}\n` }) {
  const page = await session.get(firmBase(c));
  const form = multipart(session.getCsrfToken(), fileSpec, fields);
  const res = await session.post(`${firmBase(c)}/documents`, form.body, { headers: form.headers });
  for (const r of await db.prepare('SELECT stored_path FROM tp_party_documents WHERE workspace_id=?').all(c.id)) createdPaths.add(r.stored_path);
  assert.ok(page.status === 200 || page.status === 404);
  return res;
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  otherFirmId = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Other Docs Firm')").run()).lastInsertRowid);
  consultant = await makeUser('pd-consultant@test.local');
  outsider = await makeUser('pd-outsider@test.local', { role: 'manager', firm: otherFirmId });
  A = await tprmClient('Docs Client A');
  B = await tprmClient('Docs Client B');
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

test('a consultant files a certificate on the supplier and it counts as assurance and shows its expiry', async () => {
  const s = await signIn(consultant);
  const res = await file(s, A, { kind: 'iso27001_certificate', title: 'ISO certificate 2026', issued_on: ymd(-300), expires_on: ymd(30) });
  assert.equal(res.status, 302, said(res));
  assert.match(said(res), /"ISO certificate 2026" filed/);
  const row = await docRow(A.id, 'ISO certificate 2026');
  assert.equal(row.kind, 'iso27001_certificate');
  assert.equal(Number(row.third_party_id), A.tp);
  assert.equal(row.shared_with_client, false);
  assert.match(row.sha256, /^[a-f0-9]{64}$/);
  await file(s, A, { kind: 'insurance_certificate', title: 'Cyber cover', expires_on: ymd(-5) });
  await file(s, A, { kind: 'contract', title: 'Master agreement', issued_on: ymd(-30), expires_on: ymd(700) });

  const page = await s.get(`${firmBase(A)}?tab=documents`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-party-library-upload/);
  for (const t of ['ISO certificate 2026', 'Cyber cover', 'Master agreement']) assert.match(page.text, new RegExp(t));
  assert.match(page.text, /data-tprm-party-library-expiry="soon"/);
  assert.match(page.text, /data-tprm-party-library-expiry="expired"/);
  assert.match(page.text, /data-tprm-party-library-expiry="valid"/);
  const overview = await s.get(firmBase(A));
  const renew = overview.text.slice(overview.text.indexOf('data-tprm-party-doc-expiry'));
  assert.match(renew, /data-tprm-party-doc-expiry-state="soon"/);
  assert.match(renew, /data-tprm-party-doc-expiry-state="expired"/);
  assert.doesNotMatch(renew.slice(0, renew.indexOf('</section>')), /Master agreement/, 'a document valid for years is not listed to renew');
  const iso = overview.text.match(/<div data-tprm-assurance-iso>[\s\S]*?<\/div>/)[0];
  assert.match(iso, /Valid to/);
  assert.match(iso, /filed on the supplier/);
  const events = await db.prepare(`SELECT action FROM tp_events WHERE workspace_id=? AND action LIKE 'party_document.%' ORDER BY id`).all(A.id);
  assert.deepEqual(events.map(e => e.action), ['party_document.added', 'party_document.added', 'party_document.added']);
  const dl = await s.get(`${firmBase(A)}/documents/${row.id}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.text, /%PDF-1\.4/);
});

test('a document needs a kind, a title, sensible dates and a file that passes the upload checks', async () => {
  const s = await signIn(consultant);
  const bad = await file(s, A, { kind: 'diploma', title: '', issued_on: '2026-05-10', expires_on: '2026-01-01' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Choose what the document is/);
  assert.match(bad.text, /Give the document a title/);
  assert.match(bad.text, /cannot be before the issue date/);
  const missing = await file(s, A, { kind: 'policy', title: 'No file' }, null);
  assert.equal(missing.status, 400);
  assert.match(missing.text, /Choose a file/);
  assert.equal(await docRow(A.id, 'No file'), undefined);
  const exe = await file(s, A, { kind: 'policy', title: 'Program' }, { filename: 'setup.exe', content: 'MZ\u0090\u0000binary', type: 'application/octet-stream' });
  assert.equal(exe.status, 400);
  assert.equal(await docRow(A.id, 'Program'), undefined);
  const noCsrf = multipart(null, { filename: 'x.pdf', content: PDF }, { kind: 'policy', title: 'Forged' });
  const forged = await s.post(`${firmBase(A)}/documents`, noCsrf.body, { headers: noCsrf.headers });
  assert.equal(forged.status, 403);
  assert.equal(await docRow(A.id, 'Forged'), undefined);
});

test('the client sees and downloads only shared documents, never unshared or deleted ones', async () => {
  const s = await signIn(consultant);
  await file(s, A, { kind: 'soc2_report', title: 'SOC 2 shared', expires_on: ymd(200) });
  await file(s, A, { kind: 'dpa', title: 'DPA kept internal' });
  const shared = await docRow(A.id, 'SOC 2 shared');
  const internal = await docRow(A.id, 'DPA kept internal');
  const on = await s.post(`${firmBase(A)}/documents/${shared.id}/share`, { shared: '1', row_version: shared.row_version });
  assert.match(said(on), /shared with the client/);
  assert.equal((await docRow(A.id, 'SOC 2 shared')).shared_with_client, true);

  const c = await signIn(A.contributor);
  const page = await c.get(`${portalBase(A)}?tab=documents`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-tprm-cv-library-doc="${shared.id}"`));
  assert.doesNotMatch(page.text, /DPA kept internal/);
  assert.doesNotMatch(page.text, /ISO certificate 2026/);
  assert.equal((await c.get(`${portalBase(A)}/documents/${shared.id}/download`)).status, 200);
  assert.equal((await c.get(`${portalBase(A)}/documents/${internal.id}/download`)).status, 404);

  const fresh = await docRow(A.id, 'SOC 2 shared');
  const del = await s.post(`${firmBase(A)}/documents/${shared.id}/delete`, { row_version: fresh.row_version, _tp_confirmed: '1' });
  assert.equal(del.status, 302);
  assert.match(said(del), /stays in the history/);
  const gone = await docRow(A.id, 'SOC 2 shared');
  assert.ok(gone.deleted_at, 'the row is kept');
  assert.equal(gone.shared_with_client, false);
  assert.equal((await c.get(`${portalBase(A)}/documents/${shared.id}/download`)).status, 404);
  assert.doesNotMatch((await c.get(`${portalBase(A)}?tab=documents`)).text, /SOC 2 shared/);
  const firmPage = await s.get(`${firmBase(A)}?tab=documents`);
  assert.doesNotMatch(firmPage.text, new RegExp(`data-tprm-party-library-doc="${shared.id}"`));
  assert.match((await s.get(`${firmBase(A)}?tab=history`)).text, /Document deleted/);
  assert.equal((await s.get(`${firmBase(A)}/documents/${shared.id}/download`)).status, 404);
  const stale = await s.post(`${firmBase(A)}/documents/${internal.id}/share`, { shared: '1', row_version: '99' });
  assert.match(said(stale), /reload the page/);
});

test('clients, other clients and other firms cannot file, share, delete or download', async () => {
  const s = await signIn(consultant);
  await file(s, A, { kind: 'policy', title: 'Security policy A' });
  const doc = await docRow(A.id, 'Security policy A');
  await s.post(`${firmBase(A)}/documents/${doc.id}/share`, { shared: '1', row_version: doc.row_version });

  for (const who of [A.owner, A.contributor]) {
    const c = await signIn(who);
    assert.ok([403, 404].includes((await c.post(`${firmBase(A)}/documents/${doc.id}/share`, { shared: '0', row_version: '2' })).status));
    assert.ok([403, 404].includes((await c.post(`${firmBase(A)}/documents/${doc.id}/delete`, { row_version: '2', _tp_confirmed: '1' })).status));
    assert.ok([403, 404].includes((await c.get(`${firmBase(A)}/documents/${doc.id}/download`)).status));
  }
  const otherClient = await signIn(B.owner);
  assert.equal((await otherClient.get(`${portalBase(A)}/documents/${doc.id}/download`)).status, 403);
  assert.equal((await otherClient.get(`/workspaces/${B.id}/client-portal/third-party-risk/third-parties/${A.tp}/documents/${doc.id}/download`)).status, 404);
  assert.equal((await otherClient.get(`${portalBase(B)}/documents/${doc.id}/download`)).status, 404);

  const o = await signIn(outsider);
  assert.equal((await o.get(`${firmBase(A)}/documents/${doc.id}/download`)).status, 404);
  assert.equal((await o.post(`${firmBase(A)}/documents/${doc.id}/delete`, { row_version: '2', _tp_confirmed: '1' })).status, 404);
  const crossTp = await s.post(`/tprm/clients/${B.id}/third-parties/${B.tp}/documents/${doc.id}/delete`, { row_version: '2', _tp_confirmed: '1' });
  assert.equal(crossTp.status, 404);
  const after = await docRow(A.id, 'Security policy A');
  assert.equal(after.deleted_at, null);
  assert.equal(after.shared_with_client, true);
});

test('a renewed certificate counts as assurance over the older one it replaces', async () => {
  const s = await signIn(consultant);
  const C = await tprmClient('Docs Client C');
  await file(s, C, { kind: 'iso27001_certificate', title: 'ISO old', expires_on: ymd(-10) });
  await file(s, C, { kind: 'iso27001_certificate', title: 'ISO renewed', expires_on: ymd(700) });
  const page = await s.get(firmBase(C));
  const iso = page.text.match(/<div data-tprm-assurance-iso>[\s\S]*?<\/div>/)[0];
  const day = require('../lib/tprm/format').forZone('UTC', { ymdInZone: require('../lib/dates').ymdInZone }).day;
  assert.match(iso, new RegExp(`Valid to ${day(ymd(700))}`));
  assert.match(page.text, /data-tprm-party-doc-expiry-state="expired"/, 'the old one is still listed to renew');
});

test('the certificate that runs longest counts as assurance, whichever was filed last and wherever it was filed', async () => {
  const s = await signIn(consultant);
  const E = await tprmClient('Docs Client E');
  await file(s, E, { kind: 'iso27001_certificate', title: 'ISO current', expires_on: ymd(500) });
  await file(s, E, { kind: 'iso27001_certificate', title: 'ISO lapsed, filed late', expires_on: ymd(-40) });
  const page = await s.get(firmBase(E));
  const iso = page.text.match(/<div data-tprm-assurance-iso>[\s\S]*?<\/div>/)[0];
  const day = require('../lib/tprm/format').forZone('UTC', { ymdInZone: require('../lib/dates').ymdInZone }).day;
  assert.match(iso, new RegExp(`Valid to ${day(ymd(500))}`));
  assert.doesNotMatch(iso, /Expired/);

  const { mergeAssurance } = require('../lib/tprm/firm-party');
  const library = { kind: 'iso27001', expires_on: ymd(-40), name: 'Old library copy', source: 'document' };
  const evidence = { kind: 'iso27001', expires_on: ymd(300), name: 'Evidence copy' };
  const undated = { kind: 'soc2_type2', expires_on: null, name: 'Undated SOC 2', source: 'document' };
  const dated = { kind: 'soc2_type2', expires_on: ymd(90), name: 'Dated SOC 2' };
  const merged = mergeAssurance([], [library, undated, evidence, dated]);
  assert.equal(merged.find(r => r.kind === 'iso27001').name, 'Evidence copy');
  assert.equal(merged.find(r => r.kind === 'iso27001').source, 'evidence');
  assert.equal(merged.find(r => r.kind === 'soc2_type2').name, 'Dated SOC 2');
  const report = { kind: 'iso27001', expires_on: ymd(10), check_status: 'accepted' };
  assert.equal(mergeAssurance([report], [evidence]).find(r => r.kind === 'iso27001').source, 'evidence', 'a longer certificate beats a shorter checked report');
  assert.equal(mergeAssurance([{ ...report, expires_on: ymd(300) }], [evidence]).find(r => r.kind === 'iso27001').source, 'report', 'on the same expiry the checked report comes first');
});
