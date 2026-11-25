'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');
let store;
let audit;

const PASSWORD = 'file-store-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no' };

function fakeS3() {
  const objects = new Map();
  const calls = [];
  let failPut = false;
  const notFound = () => Object.assign(new Error('not found'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  return {
    objects, calls,
    failPuts(on) { failPut = on; },
    async send({ name, input }) {
      calls.push(name);
      assert.equal(input.Bucket, 'test-bucket');
      if (name === 'PutObjectCommand') {
        if (failPut) throw Object.assign(new Error('unavailable'), { name: 'ServiceUnavailable' });
        const chunks = [];
        for await (const c of input.Body) chunks.push(c);
        objects.set(input.Key, Buffer.concat(chunks));
        return {};
      }
      if (name === 'GetObjectCommand') {
        if (!objects.has(input.Key)) throw notFound();
        return { Body: Readable.from([objects.get(input.Key)]) };
      }
      if (name === 'HeadObjectCommand') {
        if (!objects.has(input.Key)) throw notFound();
        return {};
      }
      if (name === 'DeleteObjectCommand') { objects.delete(input.Key); return {}; }
      if (name === 'ListObjectsV2Command') return { Contents: [...objects.keys()].filter(k => !input.Prefix || k.startsWith(input.Prefix)).map(Key => ({ Key })), IsTruncated: false };
      throw new Error(`unexpected command ${name}`);
    },
  };
}

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let s3;

test.before(async () => {
  env = await bootClient();
  store = require('../lib/file-store');
  audit = require('../lib/file-store-audit');
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('fs-consultant@test.local', 'consultant');
  senior = await makeUser('fs-senior@test.local', 'senior_consultant');
  for (const u of [consultant, senior]) u.session = await signIn(u.email);
  s3 = fakeS3();
  store.useClient(s3);
  process.env.ISMS_S3_BUCKET = 'test-bucket';
});

test.after(async () => {
  delete process.env.ISMS_S3_BUCKET;
  store.useClient(null);
  for (const u of [consultant, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

async function makeUser(email, role) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, firmId, role)).lastInsertRowid);
  return { id, email, firm_role: role };
}

async function signIn(email) {
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302);
  await session.get('/dashboard');
  return session;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const aBase = ctx => `/tprm/clients/${ctx.ws}/third-parties/${ctx.tp}/assessments/${ctx.a}`;

async function confirmedAssessment(name) {
  const ws = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(ws);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(ws, u.id, u.firm_role);
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name: `${name} Supplier`, status: 'in_use' });
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosted service' })).status, 302);
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  const a = idIn(started.location, /assessments\/(\d+)/);
  const ctx = { ws, tp, a };
  const rv = async () => String((await db.prepare('SELECT row_version FROM tp_assessments WHERE id=?').get(a)).row_version);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: await rv() };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ctx)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ctx)}/confirm`, { row_version: await rv() })).status, 302);
  return ctx;
}

function request(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = env.app.listen(0, '127.0.0.1', () => {
      const h = { ...headers };
      if (body != null) h['content-length'] = Buffer.byteLength(body);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: urlPath, headers: h }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { server.close(); const buffer = Buffer.concat(chunks); resolve({ status: res.statusCode, buffer, text: buffer.toString('utf8'), location: res.headers.location || null }); });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}

async function uploadEvidence(ctx, filename, content) {
  await consultant.session.get(`${aBase(ctx)}?step=evidence`);
  const boundary = '----fs' + crypto.randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${consultant.session.getCsrfToken()}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return request('POST', `${aBase(ctx)}/evidence`, { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: consultant.session.getCookies() } });
}

const local = row => path.join(store.ROOT, `firm_${firmId}`, row.stored_path);
const keyOf = row => `firm_${firmId}/${row.stored_path}`;

test('keys come only from files inside the uploads folder, one level of firm folder at most', () => {
  assert.equal(store.keyFor(path.join(store.ROOT, 'firm_3', 'a.pdf')), 'firm_3/a.pdf');
  assert.equal(store.keyFor(path.join(store.ROOT, 'legacy.pdf')), 'legacy.pdf');
  assert.equal(store.keyFor(path.join(store.ROOT, '..', 'server.js')), null);
  assert.equal(store.keyFor(path.join(store.ROOT, 'firm_3', 'x', 'a.pdf')), null);
  assert.equal(store.keyFor(path.join(store.ROOT, 'other', 'a.pdf')), null);
  assert.equal(store.pathForKey('firm_3/a.pdf'), path.join(store.ROOT, 'firm_3', 'a.pdf'));
  assert.equal(store.pathForKey('firm_3/../../x'), null);
  assert.deepEqual(store.candidates('../x', 3), []);
  assert.deepEqual(store.candidates('a.pdf', 3), [path.join(store.ROOT, 'firm_3', 'a.pdf'), path.join(store.ROOT, 'a.pdf')]);
});

test('an upload is in the bucket before it is recorded; after the server loses its copy the download still works; deleting removes it', async () => {
  const ctx = await confirmedAssessment('Bucket One');
  const res = await uploadEvidence(ctx, 'policy.txt', 'Information security policy, version 4');
  assert.equal(res.status, 302);
  const row = await db.prepare('SELECT * FROM tp_evidence WHERE assessment_id=? AND original_name=?').get(ctx.a, 'policy.txt');
  assert.ok(row, 'the file was recorded');
  assert.equal(s3.objects.get(keyOf(row)).toString(), 'Information security policy, version 4');

  fs.unlinkSync(local(row));
  const download = await request('GET', `${aBase(ctx)}/evidence/${row.id}/download`, { headers: { cookie: consultant.session.getCookies() } });
  assert.equal(download.status, 200);
  assert.equal(download.buffer.toString(), 'Information security policy, version 4');
  assert.ok(fs.existsSync(local(row)), 'the file is cached on this server again');

  await consultant.session.get(`${aBase(ctx)}?step=evidence`);
  const del = await consultant.session.post(`${aBase(ctx)}/evidence/${row.id}/delete`, { row_version: String(row.row_version) });
  assert.equal(del.status, 302);
  assert.ok(!s3.objects.has(keyOf(row)), 'deleting the evidence deletes the stored file');
  assert.ok(!fs.existsSync(local(row)));
});

test('if the bucket cannot take the file, nothing is recorded and nothing is left behind', async () => {
  const ctx = await confirmedAssessment('Bucket Down');
  const before = s3.objects.size;
  s3.failPuts(true);
  try {
    const res = await uploadEvidence(ctx, 'down.txt', 'Will not be stored');
    assert.equal(res.status, 503);
    assert.match(res.buffer.toString(), /could not be saved right now/);
  } finally {
    s3.failPuts(false);
  }
  assert.equal(await db.prepare('SELECT count(*) AS n FROM tp_evidence WHERE assessment_id=?').get(ctx.a).then(r => Number(r.n)), 0);
  assert.equal(s3.objects.size, before);
  const left = fs.readdirSync(path.join(store.ROOT, `firm_${firmId}`)).filter(n => n.endsWith('-down.txt'));
  assert.deepEqual(left, []);
});

test('a staged file the page throws away is removed from the bucket when the request ends', async () => {
  const staged = path.join(store.ROOT, `firm_${firmId}`, `${Date.now()}-staged.txt`);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, 'discard me');
  await store.put(staged);
  assert.ok(s3.objects.has(store.keyFor(staged)));
  const res = new EventEmitter();
  store.keepStaged({}, res, [{ path: staged }]);
  fs.unlinkSync(staged);
  res.emit('finish');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!s3.objects.has(store.keyFor(staged)));
});

test('the file check lists records whose file is neither on this server nor in the bucket, and copy fills the bucket', async () => {
  const ctx = await confirmedAssessment('Bucket Audit');
  assert.equal((await uploadEvidence(ctx, 'kept.txt', 'kept')).status, 302);
  assert.equal((await uploadEvidence(ctx, 'gone.txt', 'gone')).status, 302);
  const kept = await db.prepare('SELECT * FROM tp_evidence WHERE assessment_id=? AND original_name=?').get(ctx.a, 'kept.txt');
  const gone = await db.prepare('SELECT * FROM tp_evidence WHERE assessment_id=? AND original_name=?').get(ctx.a, 'gone.txt');
  fs.unlinkSync(local(kept));
  fs.unlinkSync(local(gone));
  s3.objects.delete(keyOf(gone));
  const r = await audit.check(db);
  assert.ok(r.missing.some(m => m.table === 'tp_evidence' && m.id === Number(gone.id)));
  assert.ok(!r.missing.some(m => m.table === 'tp_evidence' && m.id === Number(kept.id)));

  const extra = path.join(store.ROOT, `firm_${firmId}`, `${Date.now()}-on-disk-only.txt`);
  fs.writeFileSync(extra, 'only on disk');
  const copied = await audit.copyLocal();
  assert.ok(copied.copied >= 1);
  assert.equal(s3.objects.get(store.keyFor(extra)).toString(), 'only on disk');
  const again = await audit.copyLocal();
  assert.equal(again.copied, 0, 'files already in the bucket are not copied twice');
  fs.unlinkSync(extra);
  s3.objects.delete(store.keyFor(extra));
});

test('without a bucket nothing is sent anywhere', async () => {
  delete process.env.ISMS_S3_BUCKET;
  try {
    const calls = s3.calls.length;
    const ctx = await confirmedAssessment('No Bucket');
    assert.equal((await uploadEvidence(ctx, 'plain.txt', 'disk only')).status, 302);
    const row = await db.prepare('SELECT * FROM tp_evidence WHERE assessment_id=? AND original_name=?').get(ctx.a, 'plain.txt');
    assert.ok(fs.existsSync(local(row)));
    assert.equal(s3.calls.length, calls);
    fs.unlinkSync(local(row));
  } finally {
    process.env.ISMS_S3_BUCKET = 'test-bucket';
  }
});

test('a file the third party attaches to an answer goes to the bucket too', async () => {
  const ctx = await confirmedAssessment('Bucket Supplier');
  const qBase = `${aBase(ctx)}/questionnaire`;
  assert.equal((await consultant.session.post(qBase, {})).status, 302);
  const q = await db.prepare('SELECT row_version FROM tp_questionnaires WHERE assessment_id=?').get(ctx.a);
  const linked = await consultant.session.post(`${qBase}/links`, { recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(q.row_version) });
  const token = ((linked.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || '').split('/vendor/q/')[1];
  assert.ok(token, 'a link was shown');
  const page = (await request('GET', `/vendor/q/${token}?s=1`)).text;
  const qid = [...page.matchAll(/name="file__([A-Z]{2,6}-\d{1,4})"/g)].map(m => m[1]).find(id => page.includes(`name="r[${id}]" value="yes"`));
  assert.ok(qid, 'a question on the first section takes a file');
  const version = (page.match(new RegExp(`name="v\\[${qid}\\]" value="([0-9a-f]{20})"`)) || [])[1];
  const aft = (page.replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];
  const boundary = '----fsv' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of [['_aft', aft], [`r[${qid}]`, 'yes'], [`v[${qid}]`, version], ['intent', 'save']]) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  parts.push(`--${boundary}`, `Content-Disposition: form-data; name="file__${qid}"; filename="supplier-policy.txt"`, 'Content-Type: text/plain', '', 'Supplier security policy');
  parts.push(`--${boundary}--`, '');
  const saved = await request('POST', `/vendor/q/${token}/save`, { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(saved.status, 303);
  const row = await db.prepare(`SELECT * FROM tp_evidence WHERE assessment_id=? AND original_name='supplier-policy.txt'`).get(ctx.a);
  assert.ok(row, 'the supplier file was recorded');
  assert.equal(s3.objects.get(keyOf(row)).toString(), 'Supplier security policy');
  fs.rmSync(local(row), { force: true });
});

test('if the bucket cannot be reached the file shows as missing, not as an error', async () => {
  const ctx = await confirmedAssessment('Bucket Flaky');
  assert.equal((await uploadEvidence(ctx, 'flaky.txt', 'flaky')).status, 302);
  const row = await db.prepare('SELECT * FROM tp_evidence WHERE assessment_id=? AND original_name=?').get(ctx.a, 'flaky.txt');
  fs.unlinkSync(local(row));
  const send = s3.send;
  s3.send = async cmd => { if (cmd.name === 'GetObjectCommand') throw Object.assign(new Error('down'), { name: 'ServiceUnavailable' }); return send.call(s3, cmd); };
  try {
    const res = await request('GET', `${aBase(ctx)}/evidence/${row.id}/download`, { headers: { cookie: consultant.session.getCookies() } });
    assert.equal(res.status, 404);
    assert.match(res.text, /missing from storage/);
  } finally {
    s3.send = send;
  }
  const back = await request('GET', `${aBase(ctx)}/evidence/${row.id}/download`, { headers: { cookie: consultant.session.getCookies() } });
  assert.equal(back.status, 200, 'once the bucket answers again the file is there');
  fs.rmSync(local(row), { force: true });
});

test('deleting a firm deletes its files from the bucket and leaves other firms alone', async () => {
  s3.objects.set('firm_9901/a.txt', Buffer.from('a'));
  s3.objects.set('firm_9901/b.txt', Buffer.from('b'));
  s3.objects.set('firm_9902/c.txt', Buffer.from('c'));
  assert.equal(await store.removeFirm(9901), 2);
  assert.ok(!s3.objects.has('firm_9901/a.txt') && !s3.objects.has('firm_9901/b.txt'));
  assert.ok(s3.objects.has('firm_9902/c.txt'));
  s3.objects.delete('firm_9902/c.txt');
});
