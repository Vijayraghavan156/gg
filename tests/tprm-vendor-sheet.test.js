'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-sheet-outbox-')), 'outbox.log');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { completeAnswer, answerFormFields, bootClient, makeClient, allSteps } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tprm-question-bank.json'), 'utf8'));
const BANK_BY_ID = new Map(BANK.questions.map(q => [q.id, q]));
const AI_IDS = BANK.questions.filter(q => q.pack === 'AI Services').map(q => q.id);
function good(id, extra = {}) {
  return completeAnswer(BANK_BY_ID.get(id), id, { ref: `Policy for ${id}`, date: '2026-01-15', ...extra });
}

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let events;
let vendorRoute;
const createdPaths = new Set();

const PASSWORD = 'vendor-answers-tests-password-1234';
const LOW = {
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no',
};

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  events = require('../lib/tprm/events');
  vendorRoute = require('../routes/tprm-vendor');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('vs-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('vs-senior@test.local', { role: 'senior_consultant' });
  for (const u of [consultant, senior]) u.session = await signIn(u.email, u.password);
});

test.after(async () => {
  for (const p of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  for (const u of [consultant, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

test.beforeEach(() => {
  if (vendorRoute) { vendorRoute.limiter.reset(); vendorRoute.postLimiter.reset(); }
});

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firm : null,
    type === 'firm' ? role : null)).lastInsertRowid);
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
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firm, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (firm === firmId) {
    for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  }
  return id;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const qBase = ctx => `${aBase(ctx.ws, ctx.tp, ctx.a)}/questionnaire`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const qRow = async a => db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(a);
const linksOf = async a => db.prepare('SELECT * FROM tp_vendor_requests WHERE assessment_id=? ORDER BY id').all(a);
const answersOf = async a => db.prepare(`SELECT *, to_char(evidence_date, 'YYYY-MM-DD') AS evidence_day FROM tp_answers
  WHERE assessment_id=? ORDER BY question_id`).all(a);
const answerOf = async (a, qid) => db.prepare('SELECT * FROM tp_answers WHERE assessment_id=? AND question_id=?').get(a, qid);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);
const idsOf = q => q.sections.flatMap(s => s.ids);

async function addThirdParty(ws, name) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosted service' })).status, 302);
  return tp;
}

async function startAssessment(ws, tp, answers) {
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302, toast(started));
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(answers)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  const res = await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) });
  assert.equal(res.status, 302);
  assert.equal((await assessmentRow(a)).status, 'tier_confirmed');
  return a;
}

async function linked(name, { answers = LOW, ws = null } = {}) {
  const wsId = ws || await tprmClient(`${name} Client`);
  const tp = await addThirdParty(wsId, name);
  const a = await startAssessment(wsId, tp, answers);
  const ctx = { ws: wsId, tp, a };
  assert.equal((await consultant.session.post(qBase(ctx), {})).status, 302);
  const link = await createLink(ctx);
  assert.ok(link.token, 'a link was shown');
  return { ...ctx, token: link.token };
}

async function createLink(ctx, body = {}) {
  const row = await qRow(ctx.a);
  const res = await consultant.session.post(`${qBase(ctx)}/links`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(row.row_version), ...body,
  });
  const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
  return { res, token: url ? url.split('/vendor/q/')[1] : null };
}

function request(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = env.app.listen(0, '127.0.0.1', () => {
      const h = { ...headers };
      if (body != null && h['content-length'] == null) h['content-length'] = Buffer.byteLength(body);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: urlPath, headers: h }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), location: res.headers.location || null });
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}

const vget = token => request('GET', `/vendor/q/${token}`);
async function vsection(token, a, id) {
  const q = await db.prepare('SELECT sections FROM tp_questionnaires WHERE assessment_id=?').get(a);
  const index = q.sections.findIndex(s => s.ids.includes(id));
  assert.ok(index >= 0, `${id} is in the questionnaire`);
  return request('GET', `/vendor/q/${token}?s=${index + 1}`);
}
const aftOf = text => (String(text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];

function multipart(fields, files = []) {
  const boundary = '----tprmva' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of fields) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${f.field}"; filename="${f.filename}"`,
      `Content-Type: ${f.type || 'application/octet-stream'}`, '', f.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function answerFields(answers) {
  return answerFormFields(answers, BANK_BY_ID);
}

async function save(token, answers, { files = [], intent = 'save', aft, headers = {} } = {}) {
  const value = aft === undefined ? aftOf((await vget(token)).text) : aft;
  const fields = [...(value == null ? [] : [['_aft', value]]), ...answerFields(answers), ['intent', intent]];
  const form = multipart(fields, files);
  const res = await request('POST', `/vendor/q/${token}/save`, { body: form.body, headers: { ...form.headers, ...headers } });
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(r.stored_path);
  return res;
}

async function postForm(token, suffix, fields, { aft, headers = {} } = {}) {
  const value = aft === undefined ? aftOf((await vget(token)).text) : aft;
  const body = new URLSearchParams([...(value == null ? [] : [['_aft', value]]), ...fields]).toString();
  return await request('POST', `/vendor/q/${token}${suffix}`, { body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
}

const submitLink = (token, opts) => postForm(token, '/submit', [], opts);

async function answerAll(ctx, overrides = {}) {
  const q = await qRow(ctx.a);
  const answers = {};
  for (const id of idsOf(q)) answers[id] = good(id);
  answers['AIS-01'] = { r: 'no', d: 'No AI is used to provide the service.' };
  Object.assign(answers, overrides);
  const res = await save(ctx.token, answers);
  assert.equal(res.status, 303, `saved (${res.status}: ${res.text.slice(0, 300)})`);
  return answers;
}

async function submitted(name, opts) {
  const ctx = await linked(name, opts);
  await answerAll(ctx);
  const res = await submitLink(ctx.token);
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal((await qRow(ctx.a)).status, 'submitted');
  return ctx;
}

const firmPage = ctx => allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));


const JSZip = require('jszip');
const { xlsxRows } = require('../lib/tprm/xlsx-text');

function requestRaw(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = env.app.listen(0, '127.0.0.1', () => {
      const h = { ...headers };
      if (body != null) h['content-length'] = Buffer.byteLength(body);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: urlPath, headers: h }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8'), location: res.headers.location || null });
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}

const download = async token => {
  const res = await requestRaw('GET', `/vendor/q/${token}/spreadsheet`);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  return res;
};

async function upload(token, content, { filename = 'answers.xlsx', field = 'sheet', aft } = {}) {
  const value = aft === undefined ? aftOf((await vget(token)).text) : aft;
  const boundary = '----tprmvs' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (value != null) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_aft"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return requestRaw('POST', `/vendor/q/${token}/spreadsheet`, { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
}

const COLS = { ref: 0, answer: 3, explain: 4, evRef: 5, evDate: 6 };
const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = i => String.fromCharCode(65 + i);
async function editSheet(buffer, edit) {
  const zip = await JSZip.loadAsync(buffer);
  const main = (await xlsxRows(buffer)).find(s => s.name === 'Questionnaire');
  const rows = main.rows.map(r => ({ index: r.index, cells: [...r.cells] }));
  const set = (ref, changes) => {
    const row = rows.find(r => r.cells[0] === ref);
    assert.ok(row, `row ${ref} is in the sheet`);
    for (const [k, v] of Object.entries(changes)) row.cells[COLS[k]] = v;
  };
  edit(set, rows);
  const cell = (v, i, r) => {
    const ref = `${colName(i)}${r + 1}`;
    if (v && typeof v === 'object') return `<c r="${ref}"><v>${v.n}</v></c>`;
    return v ? `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>` : '';
  };
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map(r => `<row r="${r.index + 1}">${r.cells.map((v, i) => cell(v, i, r.index)).join('')}</row>`).join('')}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const stored = async a => (await answersOf(a)).map(r => ({ q: r.question_id, response: r.response, detail: r.detail, fields: r.fields, ref: r.evidence_ref, date: r.evidence_day }));
const savedEvents = async ctx => (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'questionnaire.answers_saved').length;
const bankRow = id => BANK_BY_ID.get(id) || {};
function kinds(q) {
  const ids = idsOf(q);
  const isYesNo = id => bankRow(id).answer_type === 'yes_no_na' && !(bankRow(id).fields && bankRow(id).fields_on === 'yes') && !bankRow(id).details_on_yes;
  return {
    yesNo: ids.filter(id => isYesNo(id) && id !== 'AIS-01'),
    freeText: ids.filter(id => bankRow(id).answer_type === 'free_text' && !(bankRow(id).fields && bankRow(id).fields_on !== 'yes')),
    fieldsAnswer: ids.filter(id => bankRow(id).answer_type === 'free_text' && bankRow(id).fields && bankRow(id).fields_on !== 'yes'),
    fieldsYes: ids.filter(id => bankRow(id).answer_type === 'yes_no_na' && bankRow(id).fields && bankRow(id).fields_on === 'yes'),
    yesDetails: ids.filter(id => bankRow(id).answer_type === 'yes_no_na' && bankRow(id).details_on_yes && !(bankRow(id).fields && bankRow(id).fields_on === 'yes')),
  };
}

test('the spreadsheet downloads with the saved answers, and uploading it unchanged changes nothing', async () => {
  const ctx = await linked('Sheet Round Co');
  const q = await qRow(ctx.a);
  const k = kinds(q);
  const answers = {};
  for (const id of idsOf(q).slice(0, 8)) answers[id] = good(id);
  if (k.yesNo[1]) answers[k.yesNo[1]] = { r: 'no', d: 'First line\r\nSecond line, with a "quote" & <angle>' };
  if (k.freeText[0]) answers[k.freeText[0]] = good(k.freeText[0], { t: '- starts with a dash\nand =looks like a formula' });
  for (const id of [k.fieldsAnswer[0], k.fieldsYes[0], k.yesDetails[0]].filter(Boolean)) answers[id] = good(id);
  assert.equal((await save(ctx.token, answers)).status, 303);
  const before = await stored(ctx.a);
  const events = await savedEvents(ctx);

  const now = await qRow(ctx.a);
  const res = await download(ctx.token);
  assert.match(res.headers['content-type'], /spreadsheetml\.sheet/);
  assert.match(res.headers['content-disposition'], /attachment; filename="security-questionnaire-Sheet-Round-Co-Client\.xlsx"/);
  assert.match(res.headers['cache-control'], /no-store/);
  const sheets = await xlsxRows(res.body);
  assert.deepEqual(sheets.map(s => [s.name, s.state]), [['Questionnaire', 'visible'], ['About this file', 'hidden']]);
  const about = Object.fromEntries(sheets[1].rows.map(r => r.cells));
  assert.deepEqual(about, { format: '1', questionnaire: String(q.id), bank_version: String(q.bank_version_id) });
  assert.ok(!res.body.includes(Buffer.from(ctx.token)), 'the link token is not in the file');
  const main = sheets[0].rows;
  const refs = main.filter(r => r.index >= 4).map(r => r.cells[0]).filter(x => !x.includes(':'));
  assert.deepEqual(refs, idsOf(now));

  const same = await upload(ctx.token, res.body);
  assert.equal(same.status, 303, same.text.slice(0, 400));
  assert.match(same.location, /notice=sheet_same/);
  assert.deepEqual(await stored(ctx.a), before);
  assert.equal(await savedEvents(ctx), events);
});

test('a filled-in spreadsheet saves through the same checks as the page, reading Excel-style values', async () => {
  const ctx = await linked('Sheet Fill Co');
  const q = await qRow(ctx.a);
  const k = kinds(q);
  const [yes1, na1] = k.yesNo;
  const file = await editSheet((await download(ctx.token)).body, set => {
    set(yes1, { answer: 'y', evRef: 'Access policy v3', evDate: { n: 46023 } });
    set(na1, { answer: 'N/A', explain: 'We do not run this service.' });
    if (k.freeText[0]) set(k.freeText[0], { answer: '-We keep logs for a year' });
  });
  const res = await upload(ctx.token, file);
  assert.equal(res.status, 303, res.text.slice(0, 600));
  assert.match(res.location, /notice=sheet_saved/);
  const a1 = await answerOf(ctx.a, yes1);
  assert.equal(a1.response, 'yes');
  assert.equal(a1.evidence_ref, 'Access policy v3');
  assert.equal((await answersOf(ctx.a)).find(r => r.question_id === yes1).evidence_day, '2026-01-01');
  const a2 = await answerOf(ctx.a, na1);
  assert.equal(a2.response, 'na');
  assert.equal(a2.detail, 'We do not run this service.');
  if (k.freeText[0]) {
    const a3 = await answerOf(ctx.a, k.freeText[0]);
    assert.equal(a3.response, 'text');
    assert.equal(a3.detail, '-We keep logs for a year', 'a leading dash is kept as typed');
  }
  assert.equal((await stored(ctx.a)).length, 2 + (k.freeText[0] ? 1 : 0), 'empty rows saved nothing');
  const saved = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'questionnaire.answers_saved');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].actor_user_id, null);

  const fieldsId = k.fieldsAnswer[0] || k.fieldsYes[0];
  if (fieldsId) {
    const row = bankRow(fieldsId);
    const def = row.fields[0];
    const withFields = await editSheet((await download(ctx.token)).body, set => {
      if (row.fields_on === 'yes') set(fieldsId, { answer: 'Yes' });
      for (const f of row.fields) set(`${fieldsId}:${f.key}`, { answer: f.kind === 'date' ? '2026-02-01' : f.kind === 'number' ? '12' : `Value for ${f.key}` });
    });
    const r2 = await upload(ctx.token, withFields);
    assert.equal(r2.status, 303, r2.text.slice(0, 600));
    const a4 = await answerOf(ctx.a, fieldsId);
    assert.ok(a4.fields && a4.fields[def.key], `the named fields of ${fieldsId} are saved`);
    const again = await upload(ctx.token, (await download(ctx.token)).body);
    assert.match(again.location, /notice=sheet_same/, 'named fields round-trip unchanged');
  }
});

test('a wrong answer, an unknown row, a different questionnaire or a file that is not a workbook saves nothing and says why', async () => {
  const ctx = await linked('Sheet Wrong Co');
  const other = await linked('Sheet Other Co');
  const q = await qRow(ctx.a);
  const [id1, id2] = kinds(q).yesNo;
  const base = (await download(ctx.token)).body;

  const maybe = await upload(ctx.token, await editSheet(base, set => { set(id1, { answer: 'Yes' }); set(id2, { answer: 'Maybe' }); }));
  assert.equal(maybe.status, 400);
  assert.match(maybe.text, new RegExp(`${id2}`));
  assert.match(maybe.text, /&#34;Maybe&#34; is not an answer to this question|"Maybe" is not an answer to this question/);
  assert.equal((await stored(ctx.a)).length, 0, 'nothing is saved when one row is wrong');

  const unknown = await upload(ctx.token, await editSheet(base, (set, rows) => { rows[rows.length - 1].cells[0] = 'ZZZ-99'; rows[rows.length - 1].cells[3] = 'Yes'; }));
  assert.equal(unknown.status, 400);
  assert.match(unknown.text, /is not a question in this questionnaire/);

  const foreign = await upload(ctx.token, (await download(other.token)).body);
  assert.equal(foreign.status, 400);
  assert.match(foreign.text, /for a different questionnaire/);

  const text = await upload(ctx.token, 'just some notes', { filename: 'notes.txt' });
  assert.equal(text.status, 400);
  assert.match(text.text, /Excel workbook \(\.xlsx\)/);
  const junk = await upload(ctx.token, 'not a zip at all', { filename: 'answers.xlsx' });
  assert.equal(junk.status, 400);
  assert.match(junk.text, /could not be read as an Excel workbook/);
  const wrongField = await upload(ctx.token, base, { field: 'files' });
  assert.equal(wrongField.status, 400);
  assert.match(wrongField.text, /Choose one filled-in spreadsheet/);
  const forged = await upload(ctx.token, base, { aft: 'nope' });
  assert.equal(forged.status, 403);
  assert.equal((await stored(ctx.a)).length, 0);
  const firmDir = path.join(ROOT, 'uploads', `firm_${firmId}`);
  const left = fs.existsSync(firmDir) ? fs.readdirSync(firmDir).filter(n => /answers\.xlsx|notes\.txt/.test(n)) : [];
  assert.deepEqual(left, [], 'uploaded spreadsheets are not kept on disk');
});

test('the spreadsheet is only for a questionnaire being answered, and cannot submit it', async () => {
  const ctx = await linked('Sheet Submit Co');
  const page = await vget(ctx.token);
  assert.match(page.text, /data-vendor-spreadsheet/);
  const file = (await download(ctx.token)).body;
  const withGo = await upload(ctx.token, file);
  assert.equal(withGo.status, 303);
  assert.equal((await qRow(ctx.a)).status !== 'submitted', true);
  const done = await submitted('Sheet Done Co');
  assert.equal((await requestRaw('GET', `/vendor/q/${done.token}/spreadsheet`)).status, 404);
  const late = await upload(done.token, file, { aft: require('../lib/tprm/vendor-answers').formToken(require('../lib/tprm/questionnaires').hashToken(done.token)) });
  assert.equal(late.status, 404);
});

test('answering Yes to AIS-01 in the spreadsheet adds the AI Services section', async () => {
  const ctx = await linked('Sheet AI Co');
  const q = await qRow(ctx.a);
  if (!idsOf(q).includes('AIS-01')) return;
  const file = await editSheet((await download(ctx.token)).body, set => set('AIS-01', { answer: 'Yes' }));
  const res = await upload(ctx.token, file);
  assert.equal(res.status, 303, res.text.slice(0, 400));
  assert.match(res.location, /notice=ai_added/);
  assert.ok(idsOf(await qRow(ctx.a)).some(id => AI_IDS.includes(id) && id !== 'AIS-01'));
});

test('a carried-over answer is confirmed from the spreadsheet only when the third party says so', async () => {
  const first = await submitted('Sheet Prefill Co');
  const cancel = await consultant.session.post(`${aBase(first.ws, first.tp, first.a)}/cancel`,
    { row_version: String((await assessmentRow(first.a)).row_version), reason: 'Superseded' });
  assert.equal(cancel.status, 302, toast(cancel));
  const a = await startAssessment(first.ws, first.tp, LOW);
  const ctx = { ws: first.ws, tp: first.tp, a };
  await consultant.session.post(qBase(ctx), {});
  ctx.token = (await createLink(ctx)).token;
  const file = (await download(ctx.token)).body;
  const main = (await xlsxRows(file)).find(s => s.name === 'Questionnaire').rows;
  assert.equal(main.find(r => r.index === 3).cells[9], 'Confirm carried-over answer');
  assert.match(main.find(r => r.cells[0] === 'GOV-02').cells[8], /Carried over from your last questionnaire/);

  const unchanged = await upload(ctx.token, file);
  assert.match(unchanged.location, /notice=sheet_same/);
  assert.ok((await answersOf(a)).every(r => !r.prefill_confirmed_at), 'uploading the file as it was confirms nothing');

  COLS.confirm = 9;
  const confirmed = await upload(ctx.token, await editSheet(file, set => set('GOV-02', { confirm: 'yes' })));
  assert.equal(confirmed.status, 303, confirmed.text.slice(0, 400));
  const rows = await answersOf(a);
  assert.ok(rows.find(r => r.question_id === 'GOV-02').prefill_confirmed_at, 'GOV-02 is confirmed');
  assert.equal(rows.filter(r => r.prefill_confirmed_at).length, 1, 'and only GOV-02');
});

test('a day and month that could be read either way is refused, not guessed', async () => {
  const ctx = await linked('Sheet Date Co');
  const [id] = kinds(await qRow(ctx.a)).yesNo;
  const res = await upload(ctx.token, await editSheet((await download(ctx.token)).body, set => set(id, { answer: 'Yes', evRef: 'Policy', evDate: '03/04/2026' })));
  assert.equal(res.status, 400);
  assert.match(res.text, /as YYYY-MM-DD, for example 2026-04-03/);
  assert.equal((await stored(ctx.a)).length, 0);
});

const versionsIn = text => Object.fromEntries([...String(text).matchAll(/name="v\[([A-Z]{2,6}-\d{1,4})\]" value="([0-9a-f]{20})"/g)].map(m => [m[1], m[2]]));
async function saveWith(token, answers, versions, aft) {
  const fields = [['_aft', aft], ...answerFields(answers), ...Object.entries(versions).map(([id, v]) => [`v[${id}]`, v]), ['intent', 'save']];
  const m = multipart(fields);
  return request('POST', `/vendor/q/${token}/save`, { body: m.body, headers: m.headers });
}

test('two people saving the same section keep each other\'s answers, and a real clash is refused with nothing saved', async () => {
  const ctx = await linked('Clash Co');
  const q = await qRow(ctx.a);
  const yes = idsOf(q).filter(id => bankRow(id).answer_type === 'yes_no_na' && id !== 'AIS-01' && (bankRow(id).explain_on || ['no', 'na']).includes('na'));
  const sec = q.sections.find(s => s.ids.filter(id => yes.includes(id)).length >= 2);
  const [id1, id2] = sec.ids.filter(id => yes.includes(id));
  const pageA = await vsection(ctx.token, ctx.a, id1);
  const pageB = await vsection(ctx.token, ctx.a, id1);
  const vA = versionsIn(pageA.text);
  const vB = versionsIn(pageB.text);
  assert.ok(vA[id1] && vA[id2], 'each question carries the version it was loaded at');
  const sectionIds = Object.keys(vA);
  const blank = Object.fromEntries(sectionIds.map(id => [id, {}]));

  const a = await saveWith(ctx.token, { ...blank, [id1]: { r: 'na', d: 'We do not do this.' } }, vA, aftOf(pageA.text));
  assert.equal(a.status, 303, a.text.slice(0, 300));
  const b = await saveWith(ctx.token, { ...blank, [id2]: { r: 'na', d: 'Not used.' } }, vB, aftOf(pageB.text));
  assert.equal(b.status, 303, 'B saved without touching what A answered');
  assert.equal((await answerOf(ctx.a, id1)).response, 'na', 'A\'s answer is kept');
  assert.equal((await answerOf(ctx.a, id2)).response, 'na');

  const clash = await saveWith(ctx.token, { ...blank, [id1]: { r: 'na', d: 'B disagrees.' } }, vB, aftOf(pageB.text));
  assert.equal(clash.status, 409);
  assert.match(clash.text, /data-vendor-clash="[A-Z]+-\d+"[\s\S]*?Not saved\.[\s\S]*?Priya Vendor changed this answer at [\s\S]*?Priya Vendor's answer: <span class="vq-pre">Not applicable\. We do not do this\./);
  assert.match(clash.text, /B disagrees\./, 'B\'s text stays in the form');
  assert.equal((await answerOf(ctx.a, id1)).detail, 'We do not do this.');
  const invalidB = await saveWith(ctx.token, { ...blank, [id2]: { r: 'na', d: '' } }, vB, aftOf(pageB.text));
  assert.equal(invalidB.status, 400, 'an explanation is missing');
  assert.equal(versionsIn(invalidB.text)[id1], vB[id1], 'the form B sees again still carries what B loaded, so B cannot later overwrite A by accident');
  const again = await saveWith(ctx.token, { ...blank, [id1]: { r: 'na', d: 'B disagrees.' } }, versionsIn(clash.text), aftOf(clash.text));
  assert.equal(again.status, 303, 'saving again from the refreshed form replaces it on purpose');
  assert.equal((await answerOf(ctx.a, id1)).detail, 'B disagrees.');
});

test('a spreadsheet downloaded before a colleague changed an answer cannot silently undo it', async () => {
  const ctx = await linked('Stale Sheet Co');
  const q = await qRow(ctx.a);
  const [id1, id2] = kinds(q).yesNo;
  const old = (await download(ctx.token)).body;
  const page = await vsection(ctx.token, ctx.a, id1);
  const blank = Object.fromEntries(Object.keys(versionsIn(page.text)).map(id => [id, {}]));
  assert.equal((await saveWith(ctx.token, { ...blank, [id1]: { r: 'na', d: 'Answered online.' } }, versionsIn(page.text), aftOf(page.text))).status, 303);

  const clash = await upload(ctx.token, await editSheet(old, set => set(id1, { answer: 'Not applicable', explain: 'From the old sheet.' })));
  assert.equal(clash.status, 409);
  assert.match(clash.text, new RegExp(`${id1}`));
  assert.match(clash.text, /after your spreadsheet was downloaded\. Nothing was saved: download a fresh spreadsheet/);
  assert.equal((await answerOf(ctx.a, id1)).detail, 'Answered online.');

  const fine = await upload(ctx.token, await editSheet(old, set => set(id2, { answer: 'Not applicable', explain: 'Filled in the sheet.' })));
  assert.equal(fine.status, 303, fine.text.slice(0, 400));
  assert.equal((await answerOf(ctx.a, id1)).detail, 'Answered online.', 'the empty row in the old sheet leaves the online answer alone');
  assert.equal((await answerOf(ctx.a, id2)).detail, 'Filled in the sheet.');
});
