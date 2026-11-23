'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { completeAnswer, answerFormFields, bootClient, makeClient, allSteps } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tprm-question-bank.json'), 'utf8'));
const KNOWN = new Set(BANK.questions.map(q => q.id));
const PASSWORD = 'rulebooks-tests-password-1234';
const LOW = {
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no', supplies_software: 'no',
};
const IND = ['IND-01', 'IND-02', 'IND-03', 'IND-04', 'IND-05', 'IND-06', 'IND-07', 'IND-08'];
const FIN4 = ['FIN-01', 'FIN-02', 'FIN-03', 'FIN-04'];

let env;
let client;
let db;
let firmId;
let otherFirmId;
let RB;
let CR;
let assembly;
let questionnaires;
let consultant;
let senior;
let otherManager;
let vendorRoute;
const createdPaths = new Set();

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  RB = require('../lib/tprm/rulebooks');
  CR = require('../lib/tprm/contract-review');
  assembly = require('../lib/tprm/questionnaire-assembly');
  questionnaires = require('../lib/tprm/questionnaires');
  vendorRoute = require('../routes/tprm-vendor');
  firmId = Number((await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id);
  otherFirmId = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Rulebooks Other Firm')`).run()).lastInsertRowid);
  consultant = await makeUser('rb-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('rb-senior@test.local', { role: 'senior_consultant' });
  otherManager = await makeUser('rb-other-manager@test.local', { role: 'manager', firm: otherFirmId });
  for (const u of [consultant, senior, otherManager]) u.session = await signIn(u.email, u.password);
});

test.after(async () => {
  for (const p of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  for (const u of [consultant, senior, otherManager]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

test.beforeEach(() => {
  if (vendorRoute) { vendorRoute.limiter.reset(); vendorRoute.postLimiter.reset(); }
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
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firm, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (firm === firmId) {
    for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  }
  return id;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = ctx => `/tprm/clients/${ctx.ws}/third-parties/${ctx.tp}/assessments/${ctx.a}`;
const qBase = ctx => `${aBase(ctx)}/questionnaire`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const qRow = async a => db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(a);
const rbRow = async (key, firm = firmId) => db.prepare('SELECT * FROM tp_rulebooks WHERE firm_id=? AND key=?').get(firm, key);
const ticksOf = async ws => (await db.prepare(`SELECT rulebook_key FROM tp_client_rulebooks WHERE workspace_id=? ORDER BY rulebook_key`)
  .all(ws)).map(r => r.rulebook_key);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);
const idsOf = q => q.sections.flatMap(s => s.ids);
const rbSections = q => q.sections.filter(s => s.kind === 'rulebook');

async function fingerprintOf(ws) {
  return RB.fingerprint((await db.prepare('SELECT rulebook_id FROM tp_client_rulebooks WHERE workspace_id=?').all(ws)).map(r => Number(r.rulebook_id)));
}

async function tick(ws, keys, session = client) {
  const ids = [];
  for (const k of keys) ids.push(String((await rbRow(k)).id));
  return await session.post(`/tprm/clients/${ws}/rulebooks`, { rulebook: ids, fingerprint: await fingerprintOf(ws) });
}

async function addThirdParty(ws, name, services = [{ description: 'Hosted service' }]) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'proposed' });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  for (const s of services) assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, s)).status, 302);
  return tp;
}

async function confirmed(ws, name, services) {
  const tp = await addThirdParty(ws, name, services);
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302, toast(started));
  const ctx = { ws, tp, a: idIn(started.location, /assessments\/(\d+)/) };
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(ctx.a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ctx)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ctx)}/confirm`, { row_version: String((await assessmentRow(ctx.a)).row_version) })).status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'tier_confirmed');
  return ctx;
}

async function prepared(ws, name, services) {
  const ctx = await confirmed(ws, name, services);
  const res = await consultant.session.post(qBase(ctx), {});
  assert.equal(res.status, 302, toast(res));
  return ctx;
}

async function createLink(ctx) {
  const row = await qRow(ctx.a);
  const res = await consultant.session.post(`${qBase(ctx)}/links`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(row.row_version) });
  const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
  assert.ok(url, 'a link was shown');
  return url.split('/vendor/q/')[1];
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
const aftOf = text => (String(text).match(/name="_aft" value="([^"]+)"/) || [])[1];

function multipart(fields) {
  const boundary = '----tprmrb' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of fields) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function save(token, answers) {
  const fields = [['_aft', aftOf((await vget(token)).text)]];
  fields.push(...answerFormFields(answers, new Map(BANK.questions.map(x => [x.id, x]))));
  fields.push(['intent', 'save']);
  const form = multipart(fields);
  return await request('POST', `/vendor/q/${token}/save`, { body: form.body, headers: form.headers });
}

async function vrulebook(token, a, title) {
  const q = await qRow(a);
  const index = q.sections.findIndex(s => s.kind === 'rulebook' && s.title === title);
  assert.ok(index >= 0, `${title} is a section`);
  return request('GET', `/vendor/q/${token}?s=${index + 1}`);
}

async function submitLink(token) {
  const body = new URLSearchParams([['_aft', aftOf((await vget(token)).text)]]).toString();
  return await request('POST', `/vendor/q/${token}/submit`, { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
}

const EXPECTED_IDS = {
  india_baseline: IND,
  rbi_commercial_banks: [...FIN4, 'RBI-02', 'RBI-03', 'RBI-05', 'RBI-06', 'RBI-07', 'RBI-08', ...IND],
  rbi_nbfc_middle_layer: [...FIN4, 'RBI-02', 'RBI-05', 'RBI-06', 'RBI-08', 'RBI-03', ...IND],
  rbi_nbfc_base_layer: [...FIN4, 'RBI-05', 'RBI-06', 'RBI-08', ...IND],
  rbi_payments_banks: [...FIN4, 'RBI-02', 'RBI-03', 'RBI-05', 'RBI-06', 'RBI-08', ...IND],
  rbi_payment_system_operators: [...FIN4, 'RBI-03', ...IND],
  sebi_cscrf: [...FIN4, 'SEB-01', 'SEB-02', 'SEB-03', 'SEB-04', 'SEB-05', ...IND],
  sebi_mii: [...FIN4, 'SEB-01', 'SEB-02', 'SEB-03', 'SEB-04', 'SEB-05', 'SEB-06', ...IND],
  irdai: [...FIN4, 'IRD-01', 'IRD-02', ...IND],
  pfrda: [...FIN4, 'PFR-01', 'PFR-02', 'PFR-03', ...IND],
  eu_gdpr: ['GDP-01', 'GDP-02', 'GDP-03', 'GDP-04', 'GDP-05'],
  eu_dora: ['FIN-01', 'FIN-03', 'DOR-01', 'DOR-02', 'DOR-03', 'DOR-04', 'DOR-05', 'DOR-06', 'DOR-07'],
  eu_nis2: ['NIS-01', 'NIS-02', 'NIS-03'],
  uk_gdpr: ['UKG-01'],
  uk_pra_fca: ['FIN-01', 'FIN-03', 'UKF-01', 'UKF-02', 'UKF-03', 'UKF-04'],
  pci_dss: ['PCI-01', 'PCI-02', 'PCI-03', 'PCI-04', 'PCI-05'],
  us_hipaa: ['HIP-01', 'HIP-02', 'HIP-03'],
  us_glba: ['GLB-01'],
  us_nydfs: ['NYD-01', 'NYD-02'],
  us_bank_regulators: ['FIN-01', 'FIN-03', 'USB-01', 'USB-02'],
  us_sec_reg_sp: ['SEC-01', 'SEC-02'],
  sg_mas: ['FIN-01', 'FIN-03', 'MAS-01', 'MAS-02', 'MAS-03', 'MAS-04'],
  sg_pdpa: ['SGP-01', 'SGP-02'],
  ae_cbuae: ['FIN-01', 'FIN-03', 'UAE-01', 'UAE-02', 'UAE-03'],
  ae_difc_adgm: ['DIF-01', 'DIF-02', 'GDP-04'],
  ae_pdpl: [],
  sa_sama: ['FIN-01', 'FIN-03', 'SAM-01', 'SAM-02', 'SAM-03'],
  sa_nca_ecc: ['NCA-01', 'NCA-02'],
  sa_pdpl: ['KSP-01', 'KSP-02'],
  ai_watch_list: Array.from({ length: 20 }, (_, i) => `AIM-${String(i + 1).padStart(2, '0')}`),
  ifsca: ['FIN-04', 'IFS-01', 'IFS-02', 'IFS-03', ...IND],
};

const F = 'Financial-sector (shared)';
const INDIA_REGULATED = ['rbi_commercial_banks', 'rbi_nbfc_middle_layer', 'rbi_nbfc_base_layer', 'rbi_payments_banks',
  'rbi_payment_system_operators', 'sebi_cscrf', 'sebi_mii', 'irdai', 'pfrda', 'ifsca'];
const I = 'India baseline (CERT-In)';
const EXPECTED_MAP = {
  india_baseline: [[I], false, null, 'active'],
  rbi_commercial_banks: [['RBI', F, I], true, 'IN', 'active'],
  rbi_nbfc_middle_layer: [['RBI', F, I], true, 'IN', 'active'],
  rbi_nbfc_base_layer: [['RBI', F, I], false, null, 'active'],
  rbi_payments_banks: [['RBI', F, I], true, 'IN', 'active'],
  rbi_payment_system_operators: [['RBI', F, I], false, 'IN', 'active'],
  sebi_cscrf: [[F, I], true, null, 'active'],
  sebi_mii: [[F, I], true, null, 'active'],
  irdai: [[F, I], true, null, 'active'],
  pfrda: [[F, I], true, null, 'active'],
  eu_gdpr: [[], false, null, 'active'],
  eu_dora: [[F], true, null, 'active'],
  eu_nis2: [[], false, null, 'active'],
  uk_gdpr: [[], false, null, 'active'],
  uk_pra_fca: [[F], true, null, 'active'],
  pci_dss: [[], false, null, 'active'],
  us_hipaa: [[], false, null, 'active'],
  us_glba: [[F], false, null, 'active'],
  us_nydfs: [[F], false, null, 'active'],
  us_bank_regulators: [[F], false, null, 'active'],
  us_sec_reg_sp: [[F], false, null, 'active'],
  sg_mas: [[F], true, null, 'active'],
  sg_pdpa: [[], false, null, 'active'],
  ae_cbuae: [[F], false, 'AE', 'active'],
  ae_difc_adgm: [[], false, null, 'active'],
  ae_pdpl: [[], false, null, 'pending'],
  sa_sama: [[F], true, 'SA', 'active'],
  sa_nca_ecc: [[], false, null, 'active'],
  sa_pdpl: [[], false, null, 'active'],
  ai_watch_list: [[], false, null, 'watch'],
  ifsca: [[F, I], false, null, 'active'],
};

test('every firm gets the 31 rulebooks of bank version 1, new firms too, each at version 1 with its history row', async () => {
  const v1 = await db.prepare('SELECT content FROM tp_question_bank_versions WHERE version = 1').get();
  const seed = RB.seedRows(v1.content);
  assert.equal(seed.length, 31);
  const pick = r => ({ key: r.key, position: Number(r.position), name: r.name, applies_to: r.applies_to, status: r.status, bank_entry: r.bank_entry,
    question_ids: r.question_ids, contract_tags: r.contract_tags, exit_plan_required: r.exit_plan_required, data_country: r.data_country,
    reference_text: r.reference_text });
  const newFirm = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Rulebooks New Firm')`).run()).lastInsertRowid);
  for (const firm of [firmId, otherFirmId, newFirm]) {
    const rows = await db.prepare('SELECT * FROM tp_rulebooks WHERE firm_id=? ORDER BY position').all(firm);
    assert.deepEqual(rows.map(pick), seed.map(pick), `firm ${firm} has the seeded rulebooks`);
    assert.ok(rows.every(r => r.enabled && r.version === 1 && r.row_version === 1));
    const versions = await db.prepare('SELECT * FROM tp_rulebook_versions WHERE firm_id=?').all(firm);
    assert.equal(versions.length, 31);
    assert.ok(versions.every(v => v.version === 1 && v.created_by === null));
  }
  assert.deepEqual(seed.map(r => r.name), BANK.rulebooks.map(r => r.rulebook), 'one per rulebook of the bank, in bank order');
  await db.prepare('SELECT tp_seed_rulebooks(?)').get(newFirm);
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS c FROM tp_rulebooks WHERE firm_id=?').get(newFirm)).c, 31);
  await db.prepare('DELETE FROM firms WHERE id=?').run(newFirm);
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS c FROM tp_rulebook_versions WHERE firm_id=?').get(newFirm)).c, 0);
});

test('the question-id parser reads all 31 rulebooks of the bank, and edge cases', () => {
  assert.equal(RB.RULEBOOK_TABLE.length, 31);
  assert.deepEqual(Object.keys(EXPECTED_IDS), RB.RULEBOOK_TABLE.map(r => r.key));
  for (const r of BANK.rulebooks) {
    const key = RB.tableEntry(r.rulebook).key;
    const p = RB.parseQuestionIds(r.question_ids, KNOWN);
    assert.deepEqual(p.ids, EXPECTED_IDS[key], `${key}: ${r.question_ids}`);
    assert.deepEqual(p.unknown, [], key);
    assert.deepEqual(p.invalid, [], key);
  }
  const notes = BANK.rulebooks.filter(r => RB.parseQuestionIds(r.question_ids, KNOWN).notes.length).map(r => RB.tableEntry(r.rulebook).key);
  assert.deepEqual(notes, ['rbi_nbfc_middle_layer', 'ai_watch_list'], 'the conditional RBI-03 and "(via AIS-01)" are reported');
  assert.deepEqual(RB.parseQuestionIds('None yet').ids, []);
  assert.deepEqual(RB.parseQuestionIds('').ids, []);
  assert.deepEqual(RB.parseQuestionIds('IND-01 to IND-03').ids, ['IND-01', 'IND-02', 'IND-03']);
  assert.deepEqual(RB.parseQuestionIds('RBI-01 to RBI-05', KNOWN).ids, ['RBI-02', 'RBI-03', 'RBI-05'], 'a range keeps only ids the bank has');
  assert.deepEqual(RB.parseQuestionIds('fin-01, FIN-01; FIN-02').ids, ['FIN-01', 'FIN-02'], 'case and repeats');
  assert.deepEqual(RB.parseQuestionIds('FIN-01, nonsense', KNOWN).invalid, ['nonsense']);
  assert.deepEqual(RB.parseQuestionIds('ZZZ-01', KNOWN).unknown, ['ZZZ-01']);
  assert.deepEqual(RB.parseQuestionIds('FIN-03 to IND-01').invalid, ['FIN-03 to IND-01'], 'a range across prefixes is refused');
});

test('mappings: contract tags, exit plans, data country and status for every rulebook', () => {
  const seed = RB.seedRows(BANK);
  assert.deepEqual(Object.keys(EXPECTED_MAP), seed.map(r => r.key));
  for (const r of seed) {
    assert.deepEqual([r.contract_tags, r.exit_plan_required, r.data_country, r.status], EXPECTED_MAP[r.key], r.key);
    assert.equal(r.contract_tags.includes(I), r.key === 'india_baseline' || INDIA_REGULATED.includes(r.key), `${r.key}: the India baseline clause`);
  }
  const checklistTags = new Set(BANK.contract_checklist.map(c => c.applies_to));
  for (const t of RB.CONTRACT_TAGS) assert.ok(checklistTags.has(t), `${t} is a checklist tag`);
  assert.deepEqual([...checklistTags].filter(t => t !== CR.ALL_CLIENTS).sort(), [...RB.CONTRACT_TAGS].sort(), 'every rulebook tag of the checklist is mapped');
  assert.equal(RB.statusFrom('Watch - regulations pending'), 'pending');
  assert.equal(RB.statusFrom('Watch - review when finalised'), 'watch');
  assert.equal(RB.statusFrom('Researched (partly unverified)'), 'active');
  assert.equal(RB.exitPlanFrom('Yes in substance - contingency'), true);
  assert.equal(RB.exitPlanFrom('Contingency for critical processes'), false);
});

test('migration 111: an upgraded firm gets the new contract tags as the next version, with history', async () => {
  const firm = otherFirmId;
  const before = {};
  for (const key of ['irdai', 'rbi_payments_banks', 'us_nydfs']) before[key] = await rbRow(key, firm);
  const oldTags = { irdai: [F], rbi_payments_banks: ['RBI', F], us_nydfs: [] };
  await db.exec('ALTER TABLE tp_rulebooks DISABLE TRIGGER tp_rulebooks_guard');
  try {
    for (const [key, tags] of Object.entries(oldTags)) {
      await db.prepare('UPDATE tp_rulebooks SET contract_tags = ?::jsonb WHERE firm_id = ? AND key = ?').run(JSON.stringify(tags), firm, key);
    }
  } finally { await db.exec('ALTER TABLE tp_rulebooks ENABLE TRIGGER tp_rulebooks_guard'); }
  const untouched = await rbRow('eu_gdpr', firm);
  await require('../migrations/111_tprm_rulebook_tags').up(db);
  for (const key of Object.keys(oldTags)) {
    const now = await rbRow(key, firm);
    assert.deepEqual(now.contract_tags, EXPECTED_MAP[key][0], `${key}: the new tags`);
    assert.equal(now.version, before[key].version + 1, `${key}: the next version`);
    const v = await db.prepare('SELECT * FROM tp_rulebook_versions WHERE rulebook_id=? AND version=?').get(now.id, now.version);
    assert.ok(v, `${key}: the version is in the history`);
    assert.deepEqual(v.contract_tags, now.contract_tags);
    assert.equal(v.created_by, null, 'written by the system');
  }
  assert.equal((await rbRow('eu_gdpr', firm)).version, untouched.version, 'a rulebook whose tags did not change is left alone');
  await require('../migrations/111_tprm_rulebook_tags').up(db);
  assert.equal((await rbRow('irdai', firm)).version, before.irdai.version + 1);
  await assert.rejects(db.prepare('UPDATE tp_rulebooks SET contract_tags = ? WHERE id = ?').run('[]', (await rbRow('irdai', firm)).id), /never change/);
  const fresh = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Rulebooks Tags Firm')`).run()).lastInsertRowid);
  const freshRow = await rbRow('sebi_cscrf', fresh);
  assert.deepEqual([freshRow.contract_tags, freshRow.version], [[F, I], 1]);
  await db.prepare('DELETE FROM firms WHERE id=?').run(fresh);
  await require('../migrations/112_tprm_rulebook_reference_texts').up(db);
});

const RESEARCH_REMARKS = /verify|unverified|pending|todo|https?:/i;

test('reference texts are clean client-facing citations; the research remarks and links are in the firm-only research note', async () => {
  const v1 = await db.prepare('SELECT content FROM tp_question_bank_versions WHERE version = 1').get();
  const seed = RB.seedRows(v1.content);
  assert.equal(Object.keys(require('../data/tprm-rulebooks').REFERENCES).length, 31, 'one reference per rulebook');
  for (const r of seed) {
    assert.ok(r.reference_text && r.reference_text.length <= 2000, `${r.key}: a reference text`);
    assert.doesNotMatch(r.reference_text, RESEARCH_REMARKS, `${r.key}: no research remarks or links in the client-facing text`);
    assert.doesNotMatch(r.reference_text, /\u2014/, `${r.key}: no em dash`);
    assert.match(r.reference_text, /^(Required under|Watch list)/, `${r.key}: reads as a sentence in the condition`);
    assert.ok(r.research_note && r.research_note.includes(String(r.bank_entry.source).trim()), `${r.key}: the bank's source is kept in the note`);
  }
  assert.equal(seed.find(r => r.key === 'rbi_commercial_banks').reference_text,
    'Required under the RBI Master Direction - Managing Risks in Outsourcing, 2025 (Commercial Banks)');
  assert.match(seed.find(r => r.key === 'rbi_commercial_banks').research_note, /para refs to verify/);
  const fresh = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Rulebooks References Firm')`).run()).lastInsertRowid);
  for (const firm of [firmId, otherFirmId, fresh]) {
    const rows = await db.prepare('SELECT key, reference_text, research_note, version FROM tp_rulebooks WHERE firm_id=? ORDER BY position').all(firm);
    assert.equal(rows.length, 31);
    for (const row of rows) {
      const want = seed.find(x => x.key === row.key);
      if (firm === fresh) assert.deepEqual([row.reference_text, row.research_note, row.version], [want.reference_text, want.research_note, 1]);
      else assert.equal(row.research_note, want.research_note, `${row.key}: the note`);
      if (row.reference_text) assert.doesNotMatch(row.reference_text, RESEARCH_REMARKS, `firm ${firm} ${row.key}`);
    }
    const versions = await db.prepare('SELECT reference_text FROM tp_rulebook_versions WHERE firm_id=? AND version=1').all(firm);
    assert.ok(versions.every(v => !RESEARCH_REMARKS.test(v.reference_text || '')), 'no version of a seeded rulebook carries remarks');
  }
  await db.prepare('DELETE FROM firms WHERE id=?').run(fresh);
});

test('migration 112: an untouched bank source text becomes the clean citation as the next version; a manager\'s text is kept; idempotent', async () => {
  const firm = otherFirmId;
  const keys = ['rbi_commercial_banks', 'irdai', 'eu_gdpr'];
  await db.exec('ALTER TABLE tp_rulebooks DISABLE TRIGGER tp_rulebooks_guard');
  try {
    for (const key of keys) {
      await db.prepare(`UPDATE tp_rulebooks SET reference_text = left(bank_entry->>'source', 2000), research_note = NULL WHERE firm_id = ? AND key = ?`)
        .run(firm, key);
    }
    await db.prepare(`UPDATE tp_rulebooks SET reference_text = 'Our own wording, verify later', research_note = NULL WHERE firm_id = ? AND key = 'sg_mas'`).run(firm);
  } finally { await db.exec('ALTER TABLE tp_rulebooks ENABLE TRIGGER tp_rulebooks_guard'); }
  const before = {};
  for (const key of [...keys, 'sg_mas']) before[key] = await rbRow(key, firm);
  assert.match(before.rbi_commercial_banks.reference_text, /para refs to verify/);
  const m112 = require('../migrations/112_tprm_rulebook_reference_texts');
  await m112.up(db);
  const seed = RB.seedRows((await db.prepare('SELECT content FROM tp_question_bank_versions WHERE version = 1').get()).content);
  for (const key of keys) {
    const now = await rbRow(key, firm);
    const want = seed.find(r => r.key === key);
    assert.equal(now.reference_text, want.reference_text, `${key}: the clean text`);
    assert.equal(now.research_note, want.research_note, `${key}: the note`);
    assert.equal(now.version, before[key].version + 1, `${key}: the next version`);
    assert.equal(now.updated_by, null, 'by the system');
    const v = await db.prepare('SELECT * FROM tp_rulebook_versions WHERE rulebook_id=? AND version=?').get(now.id, now.version);
    assert.equal(v.reference_text, want.reference_text, `${key}: the version is in the history`);
    const old = await db.prepare('SELECT * FROM tp_rulebook_versions WHERE rulebook_id=? AND version=?').get(now.id, before[key].version);
    assert.ok(old, 'the earlier version is kept as it was');
  }
  const mas = await rbRow('sg_mas', firm);
  assert.equal(mas.reference_text, 'Our own wording, verify later', 'a text a manager changed is left for the manager');
  assert.equal(mas.version, before.sg_mas.version);
  assert.ok(mas.research_note, 'the note is filled anyway');
  await m112.up(db);
  for (const key of keys) assert.equal((await rbRow(key, firm)).version, before[key].version + 1);
});

test('the question pack is chosen from the bank\'s rulebook questions, with their text', async () => {
  const rbi = await rbRow('rbi_commercial_banks');
  const url = `/tprm/settings/rulebooks/${rbi.id}`;
  const page = await client.get(url);
  const first = rbi.question_ids[0];
  assert.match(page.text, new RegExp(`<details class="tprm-pack" open><summary>[^<]*<span[^>]*>[^<]*chosen</span></summary>(?:(?!</details>)[\\s\\S])*name="question_ids" value="${first}" checked`), 'the pack holding a chosen question is open, the question ticked');
  assert.match(page.text, /name="question_ids" value="DOR-01">/, 'questions of other packs are offered, not ticked');
  assert.doesNotMatch(page.text, /<textarea[^>]*name="question_ids"/);
  const saved = await client.post(url, { enabled: '1', exit_plan_required: '1', data_country: 'IN', question_ids: [...rbi.question_ids, 'DOR-01'],
    reference_text: rbi.reference_text, research_note: rbi.research_note || '', row_version: String(rbi.row_version) });
  assert.equal(saved.status, 302, saved.text.slice(0, 300));
  const after = await rbRow('rbi_commercial_banks');
  assert.deepEqual(after.question_ids.slice(-1), ['DOR-01']);
  assert.equal(after.version, rbi.version + 1);
  assert.equal((await client.post(url, { enabled: '1', exit_plan_required: '1', data_country: 'IN', question_ids: rbi.question_ids,
    reference_text: rbi.reference_text, research_note: rbi.research_note || '', row_version: String(after.row_version) })).status, 302);
});

test('the research note: managers edit it on the rulebook page (no new version); never shown to the third party', async () => {
  const rbi = await rbRow('rbi_commercial_banks');
  const url = `/tprm/settings/rulebooks/${rbi.id}`;
  const page = await client.get(url);
  assert.match(page.text, /data-tprm-rulebook-research-note/);
  assert.match(page.text, /para refs to verify/, 'the manager sees the research remarks');
  assert.equal((await consultant.session.get(url)).status, 403);
  const body = { enabled: '1', exit_plan_required: '1', data_country: 'IN', question_ids: rbi.question_ids.join(', '),
    reference_text: rbi.reference_text, research_note: 'SENTINEL-RESEARCH-NOTE paragraph 12 to verify', row_version: String(rbi.row_version) };
  const saved = await client.post(url, body);
  assert.equal(saved.status, 302);
  assert.match(toast(saved), /Research note saved/);
  const after = await rbRow('rbi_commercial_banks');
  assert.equal(after.version, rbi.version, 'the note alone keeps the version');
  assert.equal(after.research_note, body.research_note);
  const audit = await db.prepare(`SELECT details FROM audit_log WHERE action='tprm_rulebook_changed' ORDER BY id DESC LIMIT 1`).get();
  assert.match(String(audit.details), /SENTINEL-RESEARCH-NOTE/);
  const bad = await client.post(url, { ...body, reference_text: 'RBI directions (para refs to verify)', row_version: String(after.row_version) });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /research note/);
  assert.equal((await rbRow('rbi_commercial_banks')).reference_text, rbi.reference_text);

  const ws = await tprmClient('Rulebook Note Client');
  assert.equal((await tick(ws, ['rbi_commercial_banks'])).status, 302);
  const settings = await client.get(`/tprm/clients/${ws}/settings`);
  assert.equal(settings.status, 200);
  assert.doesNotMatch(settings.text, /SENTINEL-RESEARCH-NOTE/);
  const ctx = await prepared(ws, 'Note Hosting Ltd');
  assert.doesNotMatch((await allSteps(consultant.session, aBase(ctx))).text, /SENTINEL-RESEARCH-NOTE/);
  const token = await createLink(ctx);
  const vstart = await vget(token);
  assert.equal(vstart.status, 200);
  assert.match(vstart.text, /data-vendor-section-link="RBI - Commercial Banks"/);
  const vpage = await vrulebook(token, ctx.a, 'RBI - Commercial Banks');
  assert.match(vpage.text, /data-vendor-section="RBI - Commercial Banks"/);
  for (const page of [vstart, vpage]) assert.doesNotMatch(page.text, /SENTINEL-RESEARCH-NOTE|para refs to verify|rbi\.org\.in/);
  assert.ok(!JSON.stringify((await qRow(ctx.a)).rulebooks).includes('SENTINEL'), 'the pin carries no note');
  const cur = await rbRow('rbi_commercial_banks');
  assert.equal((await client.post(url, { ...body, research_note: rbi.research_note, row_version: String(cur.row_version) })).status, 302);
});

test('countries: names, codes and aliases are normalised; free text is read for country names', () => {
  assert.equal(RB.normaliseCountry('India'), 'IN');
  assert.equal(RB.normaliseCountry('in'), 'IN');
  assert.equal(RB.normaliseCountry('Mumbai'), 'IN');
  assert.equal(RB.normaliseCountry('UAE'), 'AE');
  assert.equal(RB.normaliseCountry('KSA'), 'SA');
  assert.equal(RB.normaliseCountry('United Kingdom'), 'GB');
  assert.equal(RB.normaliseCountry('India (Mumbai)'), 'IN');
  assert.equal(RB.normaliseCountry('AWS eu-west-1'), null);
  assert.deepEqual(RB.hostingCountries('India; Singapore / UAE\nAWS eu-west-1, India and Singapore'),
    { codes: ['IN', 'SG', 'AE'], unknown: ['AWS eu-west-1'] });
  assert.deepEqual(RB.hostingCountries('Antigua and Barbuda').codes, ['AG'], 'a country with "and" in its name');
  assert.deepEqual(RB.countriesInText('Primary in Mumbai, backups in Singapore and the UK').sort(), ['GB', 'IN', 'SG']);
  assert.deepEqual(RB.countriesInText('Stored only in our own data centres'), []);
});

test('managers edit a rulebook: each change is the next version and every version is kept; others cannot', async () => {
  await tprmClient('Rulebook Settings Client');
  const mas = await rbRow('sg_mas');
  const url = `/tprm/settings/rulebooks/${mas.id}`;
  assert.equal((await consultant.session.get('/tprm/settings/rulebooks')).status, 403);
  assert.equal((await consultant.session.get(url)).status, 403);
  assert.equal((await consultant.session.post(url, { question_ids: 'FIN-01', row_version: '1' })).status, 403);
  const list = await client.get('/tprm/settings/rulebooks');
  assert.equal(list.status, 200);
  assert.equal((list.text.match(/data-tprm-rulebook="/g) || []).length, 31);
  assert.match((await client.get('/tprm')).text, /data-tprm-rulebooks-link/);
  const page = await client.get(url);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-rulebook-form/);
  assert.match(page.text, /FIN-01, FIN-03, MAS-01, MAS-02, MAS-03, MAS-04/);

  const body = { enabled: '1', question_ids: 'FIN-01, MAS-01 to MAS-04', exit_plan_required: '1', data_country: 'SG',
    reference_text: 'MAS Guidelines on Outsourcing (Banks)', row_version: String(mas.row_version) };
  const saved = await client.post(url, body);
  assert.equal(saved.status, 302, toast(saved));
  assert.match(toast(saved), /Saved as version 2/);
  const v2 = await rbRow('sg_mas');
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.question_ids, ['FIN-01', 'MAS-01', 'MAS-02', 'MAS-03', 'MAS-04']);
  assert.equal(v2.data_country, 'SG');
  const versions = await db.prepare('SELECT * FROM tp_rulebook_versions WHERE rulebook_id=? ORDER BY version').all(mas.id);
  assert.deepEqual(versions.map(v => v.version), [1, 2]);
  assert.deepEqual(versions[0].question_ids, mas.question_ids, 'version 1 is kept as it was');
  assert.equal(versions[0].data_country, null);
  assert.equal(Number(versions[1].created_by), Number((await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id));
  const audit = await db.prepare(`SELECT details FROM audit_log WHERE action='tprm_rulebook_changed' AND entity_id=? ORDER BY id DESC`).get(String(mas.id));
  assert.ok(audit, 'audit-logged');
  assert.match(String(audit.details), /"version":2/);
  assert.match((await client.get(url)).text, /data-tprm-rulebook-version="2"/);

  const same = await client.post(url, { ...body, row_version: String(v2.row_version) });
  assert.match(toast(same), /No changes to save/);
  assert.equal((await rbRow('sg_mas')).version, 2);
  const stale = await client.post(url, { ...body, reference_text: 'x', row_version: String(mas.row_version) });
  assert.match(toast(stale), /Someone else changed this rulebook/);
  const bad = await client.post(url, { ...body, question_ids: 'FIN-01, nonsense, ZZZ-99', data_country: 'XX', row_version: String(v2.row_version) });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /not question ids: nonsense/);
  assert.match(bad.text, /not in the question bank: ZZZ-99/);
  assert.match(bad.text, /Choose the country from the list/);
  assert.equal((await rbRow('sg_mas')).version, 2);
  const { _csrf: _unused, ...noToken } = body;
  assert.equal((await client.post(url, { ...noToken, row_version: String(v2.row_version) }, { csrf: false })).status, 403);
  assert.equal((await otherManager.session.get(url)).status, 404);
  assert.equal((await otherManager.session.post(url, { ...noToken, row_version: String(v2.row_version) })).status, 404);
  assert.doesNotMatch((await otherManager.session.get('/tprm/settings/rulebooks')).text, new RegExp(`/tprm/settings/rulebooks/${mas.id}"`));

  await assert.rejects(db.prepare('UPDATE tp_rulebooks SET reference_text = ? WHERE id = ?').run('quiet edit', mas.id), /next version/);
  await assert.rejects(db.prepare('UPDATE tp_rulebooks SET name = ? WHERE id = ?').run('Renamed', mas.id), /never change/);
  await assert.rejects(db.prepare('UPDATE tp_rulebooks SET contract_tags = ? WHERE id = ?').run('[]', mas.id), /never change/);
  await assert.rejects(db.prepare('UPDATE tp_rulebooks SET version = version + 1 WHERE id = ?').run(mas.id), /needs a change/);
  await assert.rejects(db.prepare('DELETE FROM tp_rulebooks WHERE id = ?').run(mas.id), /never deleted/);
  await assert.rejects(db.prepare('UPDATE tp_rulebook_versions SET enabled = false WHERE rulebook_id = ?').run(mas.id), /never changes/);
  await assert.rejects(db.prepare('DELETE FROM tp_rulebook_versions WHERE rulebook_id = ?').run(mas.id), /never deleted/);
  await assert.rejects(db.prepare(`INSERT INTO tp_rulebook_versions (firm_id, rulebook_id, version, question_ids, contract_tags, exit_plan_required, enabled)
    VALUES (?, ?, 3, '[]', '[]', false, true)`).run(firmId, mas.id), /as it is/);
  await assert.rejects(RB.update(db, { id: consultant.id, user_type: 'firm', firm_id: firmId, firm_role: 'consultant' }, mas.id, body), e => e.status === 403);
});

test('per-client ticks: managers only, active and switched-on rulebooks only, isolated, CSRF, audit-logged', async () => {
  const ws = await tprmClient('Rulebook Ticks Client');
  const page = await client.get(`/tprm/clients/${ws}/settings`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-client-rulebooks-form/);
  assert.equal((page.text.match(/data-tprm-client-rulebook="/g) || []).length, 31);
  assert.match(page.text, /data-tprm-client-rulebook="ai_watch_list"[^>]*>\s*<input type="checkbox" name="rulebook" value="\d+"\s+disabled/);
  assert.match(page.text, /data-tprm-client-rulebook="ae_pdpl"[^>]*>\s*<input type="checkbox" name="rulebook" value="\d+"\s+disabled/);
  assert.equal((await tick(ws, ['india_baseline'], consultant.session)).status, 403, 'a consultant cannot tick');

  const res = await tick(ws, ['india_baseline', 'rbi_commercial_banks']);
  assert.equal(res.status, 302, toast(res));
  assert.match(toast(res), /apply from the client's next questionnaire/);
  assert.deepEqual(await ticksOf(ws), ['india_baseline', 'rbi_commercial_banks']);
  const ticked = await db.prepare('SELECT * FROM tp_client_rulebooks WHERE workspace_id=?').all(ws);
  assert.ok(ticked.every(t => t.ticked_by != null && t.ticked_at));
  const audit = await db.prepare(`SELECT details FROM audit_log WHERE action='tprm_client_rulebooks_changed' AND workspace_id=?`).get(ws);
  assert.match(String(audit.details), /rbi_commercial_banks/);
  assert.match((await client.get(`/tprm/clients/${ws}/settings`)).text, /data-tprm-client-rulebook="rbi_commercial_banks" data-tprm-client-rulebook-ticked="1"/);

  const stale = await client.post(`/tprm/clients/${ws}/rulebooks`, { rulebook: [String((await rbRow('pci_dss')).id)], fingerprint: 'none' });
  assert.match(toast(stale), /Someone else changed/);
  assert.deepEqual(await ticksOf(ws), ['india_baseline', 'rbi_commercial_banks']);
  for (const key of ['ai_watch_list', 'ae_pdpl']) {
    const refused = await tick(ws, ['india_baseline', 'rbi_commercial_banks', key]);
    assert.match(toast(refused), /cannot be ticked/);
    const rb = await rbRow(key);
    await assert.rejects(db.prepare('INSERT INTO tp_client_rulebooks (workspace_id, firm_id, rulebook_id, rulebook_key) VALUES (?, ?, ?, ?)')
      .run(ws, firmId, rb.id, rb.key), /only an active rulebook/);
  }
  const pci = await rbRow('pci_dss');
  assert.equal((await client.post(`/tprm/settings/rulebooks/${pci.id}`, { question_ids: pci.question_ids.join(', '), row_version: String(pci.row_version) })).status, 302);
  assert.equal((await rbRow('pci_dss')).enabled, false);
  assert.match(toast(await tick(ws, ['india_baseline', 'rbi_commercial_banks', 'pci_dss'])), /Switched off by your firm/);
  const pciOff = await rbRow('pci_dss');
  assert.equal((await client.post(`/tprm/settings/rulebooks/${pciOff.id}`, { enabled: '1', question_ids: pci.question_ids.join(', '), row_version: String(pciOff.row_version) })).status, 302);
  const foreign = await rbRow('india_baseline', otherFirmId);
  const cross = await client.post(`/tprm/clients/${ws}/rulebooks`, { rulebook: [String(foreign.id)], fingerprint: await fingerprintOf(ws) });
  assert.match(toast(cross), /Choose rulebooks from the list/);
  await assert.rejects(db.prepare('INSERT INTO tp_client_rulebooks (workspace_id, firm_id, rulebook_id, rulebook_key) VALUES (?, ?, ?, ?)')
    .run(ws, otherFirmId, foreign.id, foreign.key), /its own firm/);
  await assert.rejects(db.prepare('UPDATE tp_client_rulebooks SET ticked_by = NULL WHERE workspace_id = ?').run(ws), /never changes/);
  assert.equal((await otherManager.session.post(`/tprm/clients/${ws}/rulebooks`, { rulebook: [], fingerprint: await fingerprintOf(ws) })).status, 404);
  assert.equal((await client.post(`/tprm/clients/${ws}/rulebooks`, { rulebook: [], fingerprint: await fingerprintOf(ws) }, { csrf: false })).status, 403);
  assert.equal((await consultant.session.get(`/tprm/clients/${ws}/settings`)).status, 403, 'the settings page stays manager-only');
  assert.equal((await tick(ws, ['rbi_commercial_banks'])).status, 302);
  assert.deepEqual(await ticksOf(ws), ['rbi_commercial_banks']);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(ws);
  assert.deepEqual(await ticksOf(ws), []);
});

test('assembly: rulebook rows by id, asked once, consultant rows apart, every delivery model, pack names still work', () => {
  const pins = RB.seedRows(BANK).filter(r => ['india_baseline', 'rbi_commercial_banks', 'eu_dora'].includes(r.key));
  for (const model of assembly.DELIVERY_MODELS) {
    const r = assembly.assemble(BANK, { tier: 'low', deliveryModel: model, modules: [], rulebooks: pins });
    const sections = r.sections.filter(s => s.kind === 'rulebook');
    assert.deepEqual(sections.map(s => s.title), ['India baseline (CERT-In + DPDP)', 'RBI - Commercial Banks', 'EU - DORA'], model);
    assert.deepEqual(sections[0].ids, IND);
    assert.deepEqual(sections[1].ids, [...FIN4, 'RBI-02', 'RBI-03', 'RBI-05', 'RBI-06', 'RBI-07'], 'IND rows are not asked twice');
    assert.deepEqual(sections[2].ids, ['DOR-01', 'DOR-02', 'DOR-03', 'DOR-04', 'DOR-05', 'DOR-06', 'DOR-07'], 'FIN-01 / FIN-03 once');
    assert.deepEqual(r.consultantChecks.filter(c => c.kind === 'rulebook').map(c => c.id), ['RBI-08']);
    const all = r.sections.flatMap(s => s.ids);
    assert.equal(all.length, new Set(all).size, 'no question twice');
    assert.equal(r.counts.rulebooks['RBI - Commercial Banks'], 9);
  }
  const bank = { questions: [
    { id: 'B-1', set: 'Base', pack: '-', domain: 'D1', min_tier: 'Low', delivery_models: 'Vendor-hosted', answered_by: 'Vendor' },
    { id: 'R-1', set: 'Rulebook pack', pack: 'RB', domain: 'D1', min_tier: 'All tiers', delivery_models: 'Client-hosted', answered_by: 'Vendor' },
    { id: 'R-2', set: 'Rulebook pack', pack: 'RB', domain: 'D1', min_tier: 'All tiers', delivery_models: 'Any (when rulebook ticked)', answered_by: 'Vendor' },
  ] };
  const rb = [{ name: 'X', question_ids: ['B-1', 'R-1', 'R-2'] }];
  assert.deepEqual(assembly.assemble(bank, { tier: 'low', deliveryModel: 'vendor_hosted', rulebooks: rb }).sections.pop(), { kind: 'rulebook', title: 'X', ids: ['R-2'] });
  assert.deepEqual(assembly.assemble(bank, { tier: 'low', deliveryModel: 'client_hosted', rulebooks: rb }).sections.pop(), { kind: 'rulebook', title: 'X', ids: ['R-1', 'R-2'] });
  assert.deepEqual(assembly.assemble(bank, { tier: 'low', deliveryModel: 'vendor_hosted', rulebooks: ['RB'] }).sections.pop(), { kind: 'rulebook', title: 'RB', ids: ['R-2'] });
});

test('preparing pins the ticked rulebooks; later ticks and edits change nothing prepared; the third party never gets consultant rows', async () => {
  const ws = await tprmClient('Rulebook Pinning Client');
  assert.equal((await tick(ws, ['india_baseline', 'rbi_commercial_banks'])).status, 302);
  const ctx = await confirmed(ws, 'Pinned Hosting Ltd');
  const before = await allSteps(consultant.session, aBase(ctx));
  assert.match(before.text, /data-tprm-rulebooks-to-pin>[\s\S]*?India baseline \(CERT-In \+ DPDP\), RBI - Commercial Banks/);
  assert.equal((await consultant.session.post(qBase(ctx), {})).status, 302);
  const q = await qRow(ctx.a);
  const rbi = await rbRow('rbi_commercial_banks');
  assert.deepEqual(q.rulebooks.map(r => [r.key, r.version]), [['india_baseline', 1], ['rbi_commercial_banks', rbi.version]]);
  assert.equal(q.rulebooks[1].data_country, 'IN');
  assert.deepEqual(rbSections(q).map(s => [s.title, s.ids]), [
    ['India baseline (CERT-In + DPDP)', IND],
    ['RBI - Commercial Banks', [...FIN4, 'RBI-02', 'RBI-03', 'RBI-05', 'RBI-06', 'RBI-07']],
  ]);
  assert.ok(q.consultant_check_ids.includes('RBI-08'));
  assert.ok(!idsOf(q).includes('RBI-08'));
  assert.equal(q.vendor_question_count, 23 + 12 + 17, 'Low vendor-hosted base, Hosting Platform & Cloud Provider and 17 regulatory questions');
  const ev = (await chain(ws, ctx.a)).find(e => e.action === 'questionnaire.prepared');
  assert.deepEqual(ev.after_state.rulebooks.map(r => r.key), ['india_baseline', 'rbi_commercial_banks']);
  assert.equal(ev.after_state.rulebook_question_count, 17);
  const page = await allSteps(consultant.session, aBase(ctx));
  assert.match(page.text, /data-tprm-regulatory-count>17</);
  assert.match(page.text, /data-tprm-rulebook-section="india_baseline"/);
  assert.match(page.text, /data-tprm-rulebook-section="rbi_commercial_banks"/);
  assert.match(page.text, /data-tprm-consultant-check="RBI-08"/);

  assert.equal((await tick(ws, ['eu_gdpr'])).status, 302);
  const cur = await rbRow('rbi_commercial_banks');
  const edit = await client.post(`/tprm/settings/rulebooks/${cur.id}`, { enabled: '1', exit_plan_required: '1', data_country: 'IN',
    question_ids: 'FIN-01', reference_text: cur.reference_text, row_version: String(cur.row_version) });
  assert.equal(edit.status, 302, toast(edit));
  const mod = await consultant.session.post(`${qBase(ctx)}/modules`, { op: 'add', module: 'Personal Data & Privacy', reason: 'Handles staff data',
    row_version: String(q.row_version) });
  assert.equal(mod.status, 302, toast(mod));
  const after = await qRow(ctx.a);
  assert.deepEqual(after.rulebooks, q.rulebooks, 'the pin never changes');
  assert.deepEqual(rbSections(after), rbSections(q), 'the regulatory sections stay with a module change');
  await assert.rejects(db.prepare(`UPDATE tp_questionnaires SET rulebooks = '[]'::jsonb WHERE id = ?`).run(q.id), /never change/);

  const next = await prepared(ws, 'Next Hosting Ltd');
  assert.deepEqual((await qRow(next.a)).rulebooks.map(r => r.key), ['eu_gdpr']);
  const back = await rbRow('rbi_commercial_banks');
  assert.equal((await client.post(`/tprm/settings/rulebooks/${back.id}`, { enabled: '1', exit_plan_required: '1', data_country: 'IN',
    question_ids: rbi.question_ids.join(', '), reference_text: rbi.reference_text, row_version: String(back.row_version) })).status, 302);

  const token = await createLink(ctx);
  assert.equal((await vget(token)).status, 200);
  const vpage = await vrulebook(token, ctx.a, 'RBI - Commercial Banks');
  assert.equal(vpage.status, 200);
  assert.match(vpage.text, /data-vendor-section="RBI - Commercial Banks"/);
  assert.match(vpage.text, /data-vendor-question="RBI-02"/);
  assert.doesNotMatch(vpage.text, /data-vendor-question="RBI-08"/);
  const yes = await save(token, { 'AIS-01': { r: 'yes' } });
  assert.equal(yes.status, 303, yes.text.slice(0, 300));
  const withAi = await qRow(ctx.a);
  assert.ok(withAi.sections.some(s => s.kind === 'module' && s.title === 'AI Services'), 'AI Services added');
  assert.deepEqual(rbSections(withAi), rbSections(after), 'the regulatory sections stay when AI Services is added');

  const answers = {};
  for (const id of idsOf(withAi)) {
    const row = BANK.questions.find(x => x.id === id) || {};
    answers[id] = completeAnswer(row, id, { ref: `Policy for ${id}`, date: '2026-01-15' });
  }
  answers['AIS-01'] = { r: 'yes' };
  answers['RBI-02'] = { r: 'no', d: 'Backups are kept in Singapore.' };
  assert.equal((await save(token, answers)).status, 303);
  const sub = await submitLink(token);
  assert.equal(sub.status, 200, sub.text.slice(0, 300));
  const flagged = await allSteps(consultant.session, aBase(ctx));
  assert.match(flagged.text, /data-tprm-data-location-answer="RBI-02"/);
  assert.match(flagged.text, /Pinned when the questionnaire was prepared|Rulebooks pinned when the questionnaire was prepared/);
  const answerId = (await db.prepare(`SELECT id FROM tp_answers WHERE assessment_id=? AND question_id='RBI-02'`).get(ctx.a)).id;
  const form = await consultant.session.get(`${aBase(ctx)}/data-location/finding?answer=${answerId}&country=IN`);
  assert.equal(form.status, 200);
  assert.match(form.text, /data-tprm-finding-from-data-location="answer"/);
  assert.match(form.text, /Data location: answer to RBI-02 \(India\)/);
  assert.match(form.text, /value="A\.5\.31"/);
});

test('contract checklist: the pinned rulebooks add their clauses; a checklist started earlier gets them at prepare; display filter', async () => {
  const ws = await tprmClient('Rulebook Contract Client');
  assert.equal((await tick(ws, ['rbi_commercial_banks'])).status, 302);
  const ctx = await prepared(ws, 'Contract Pinned Ltd');
  assert.equal((await consultant.session.post(`${aBase(ctx)}/contract-review/start`, {})).status, 302);
  const rows = await db.prepare('SELECT clause_id, applies_to FROM tp_contract_reviews WHERE assessment_id=? ORDER BY position').all(ctx.a);
  const tagged = t => BANK.contract_checklist.filter(c => c.applies_to === t).map(c => c.id);
  assert.equal(rows.length, 39 + 7 + 1, 'RBI alone: the RBI and shared clauses, and the India baseline one (migration 111)');
  assert.deepEqual(rows.filter(r => r.applies_to !== CR.ALL_CLIENTS).map(r => r.clause_id).sort(),
    [...tagged('RBI'), ...tagged(F), ...tagged(I)].sort());
  assert.ok(rows.some(r => r.clause_id === 'CT-26'), 'CT-26 without ticking India baseline');
  assert.deepEqual(rows.map(r => r.clause_id), BANK.contract_checklist.map(c => c.id), 'in the bank\'s order');
  const ev = (await chain(ws, ctx.a)).find(e => e.action === 'contract_review.started');
  assert.deepEqual(ev.after_state.applies_to, [CR.ALL_CLIENTS, 'RBI', F, I]);
  assert.equal(ev.after_state.rulebooks_from, 'questionnaire');
  const page = await consultant.session.get(`${aBase(ctx)}/contract-review`);
  const hiddenConditional = BANK.contract_checklist.filter(c => c.required === 'Conditional' && c.module !== 'Hosting Platform & Cloud Provider').length;
  assert.equal((page.text.match(/data-tprm-clause="/g) || []).length, 47 - hiddenConditional, 'every rulebook clause shows; conditional ones follow the modules');
  assert.match(page.text, /data-tprm-contract-rulebooks="questionnaire"/);

  const ws2 = await tprmClient('Rulebook Contract Later Client');
  assert.equal((await tick(ws2, ['india_baseline'])).status, 302);
  const early = await confirmed(ws2, 'Contract Early Ltd');
  assert.equal((await consultant.session.post(`${aBase(early)}/contract-review/start`, {})).status, 302);
  const firstRows = await db.prepare('SELECT clause_id FROM tp_contract_reviews WHERE assessment_id=?').all(early.a);
  assert.equal(firstRows.length, 40);
  assert.ok(firstRows.some(r => r.clause_id === 'CT-26'));
  assert.equal((await chain(ws2, early.a)).find(e => e.action === 'contract_review.started').after_state.rulebooks_from, 'client');
  assert.equal((await tick(ws2, ['india_baseline', 'rbi_commercial_banks'])).status, 302);
  assert.equal((await consultant.session.post(qBase(early), {})).status, 302);
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS c FROM tp_contract_reviews WHERE assessment_id=?').get(early.a)).c, 47);
  const added = (await chain(ws2, early.a)).find(e => e.action === 'contract_review.clauses_added');
  assert.deepEqual(added.after_state.clause_ids.sort(), [...tagged('RBI'), ...tagged(F)].sort());

  const rbiRow = { applies_to: 'RBI', conditional: false, status: 'not_reviewed' };
  assert.equal(CR.isVisible(rbiRow, null, ['RBI']), true);
  assert.equal(CR.isVisible(rbiRow, null, [I]), false);
  assert.equal(CR.isVisible({ ...rbiRow, status: 'missing' }, null, [I]), true);
  assert.equal(CR.isVisible({ applies_to: CR.ALL_CLIENTS, conditional: false, status: 'not_reviewed' }, null, []), true);
});

test('data location: services hosted outside the required country are flagged on the third-party and assessment pages', async () => {
  const ws = await tprmClient('Rulebook Location Client');
  const plain = await addThirdParty(ws, 'Plain Ltd', [{ description: 'Hosting', hosting_countries: 'Singapore' }]);
  assert.doesNotMatch((await consultant.session.get(`/tprm/clients/${ws}/third-parties/${plain}`)).text, /data-tprm-data-location/);
  assert.equal((await tick(ws, ['india_baseline', 'rbi_commercial_banks'])).status, 302);
  const services = [
    { description: 'Core hosting', hosting_countries: 'India, Singapore' },
    { description: 'DR site', hosting_countries: 'Mumbai' },
    { description: 'Analytics', hosting_countries: 'AWS eu-west-1' },
    { description: 'Support desk' },
  ];
  const ctx = await confirmed(ws, 'Located Ltd', services);
  const tpPage = await consultant.session.get(`/tprm/clients/${ws}/third-parties/${ctx.tp}`);
  assert.equal(tpPage.status, 200);
  assert.match(tpPage.text, /data-tprm-data-location data-tprm-data-location-flags="1"/);
  const core = (await db.prepare(`SELECT id FROM tp_services WHERE third_party_id=? AND description='Core hosting'`).get(ctx.tp)).id;
  assert.match(tpPage.text, new RegExp(`data-tprm-data-location-service="${core}" data-tprm-data-location-country="IN"`));
  assert.match(tpPage.text, /Singapore/);
  assert.match(tpPage.text, /No hosting country recorded: Support desk/);
  assert.match(tpPage.text, /Analytics: AWS eu-west-1/);
  assert.doesNotMatch(tpPage.text, /data-tprm-data-location-raise/, 'findings are raised on the assessment page');
  const aPage = await allSteps(consultant.session, aBase(ctx));
  assert.match(aPage.text, /data-tprm-data-location-raise/);
  assert.match(aPage.text, /The client(&#39;|')s rulebooks now/);
  const form = await consultant.session.get(`${aBase(ctx)}/data-location/finding?service=${core}&country=IN`);
  assert.equal(form.status, 200);
  assert.match(form.text, /Data location: &#34;Core hosting&#34; hosted outside India|Data location: "Core hosting" hosted outside India/);
  const saved = await consultant.session.post(`${aBase(ctx)}/findings`, { control_ref: 'A.5.31', severity: 'low',
    title: 'Data location: Core hosting hosted outside India', description: 'Hosted in Singapore too.', status: 'open' });
  assert.equal(saved.status, 302, toast(saved));
  assert.equal((await consultant.session.get(`${aBase(ctx)}/data-location/finding?service=${core}&country=AE`)).status, 404);
  assert.equal((await otherManager.session.get(`${aBase(ctx)}/data-location/finding?service=${core}&country=IN`)).status, 404);
  assert.equal((await otherManager.session.get(`/tprm/clients/${ws}/third-parties/${ctx.tp}`)).status, 404);
  assert.equal((await consultant.session.post(qBase(ctx), {})).status, 302);
});

test('data location: answers to the data-location questions are flagged by response or by the countries they name', () => {
  const countries = RB.dataCountriesOf([{ name: 'RBI - Commercial Banks', data_country: 'IN' }, { name: 'UAE - CBUAE banks', data_country: 'AE' },
    { name: 'Saudi Arabia - SAMA', data_country: 'SA' }]);
  assert.deepEqual(countries.map(c => c.country), ['IN', 'AE', 'SA']);
  const flags = RB.answerFlags([
    { id: 1, question_id: 'RBI-02', response: 'no', detail: 'Backups in Singapore' },
    { id: 2, question_id: 'RBI-02', response: 'yes', detail: null },
    { id: 3, question_id: 'UAE-01', response: 'partial', detail: 'Master copy in Dubai, replica in Ireland' },
    { id: 4, question_id: 'UAE-02', response: 'yes', detail: 'Support staff in India can access it' },
    { id: 5, question_id: 'UAE-02', response: 'no', detail: null },
    { id: 6, question_id: 'SAM-01', response: 'yes', detail: 'Riyadh, with backups in Frankfurt' },
    { id: 7, question_id: 'SAM-01', response: 'yes', detail: 'Riyadh only' },
    { id: 8, question_id: 'SEB-05', response: 'yes', detail: 'In Singapore' },
    { id: 9, question_id: 'FIN-01', response: 'no', detail: 'Singapore' },
  ], countries);
  assert.deepEqual(flags.map(f => [f.answer_id, f.reason]), [[1, 'response'], [3, 'response'], [4, 'response'], [6, 'names_other_country'], [8, 'names_other_country']]);
  assert.deepEqual(flags.find(f => f.answer_id === 6).outside, ['DE']);
  assert.deepEqual(RB.answerFlags([{ id: 1, question_id: 'SAM-01', response: 'yes', detail: 'Our own data centres' }], countries).map(f => f.reason), ['no_country_named']);
  assert.deepEqual(RB.answerFlags([{ id: 1, question_id: 'RBI-02', response: 'no', detail: null }], []), [], 'no country required: no flag');
  assert.deepEqual(Object.keys(RB.DATA_LOCATION_QUESTIONS), ['RBI-02', 'SEB-05', 'UAE-01', 'UAE-02', 'SAM-01']);
  for (const id of Object.keys(RB.DATA_LOCATION_QUESTIONS)) assert.ok(KNOWN.has(id), `${id} is in the bank`);
});

test('only the rulebook module and the restore check name the rulebook tables', () => {
  const offenders = [];
  const walk = dir => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? walk(rel) : (/\.(js|ejs)$/.test(e.name) ? [rel] : []);
  });
  for (const file of [...walk('lib'), ...walk('routes'), ...walk('views'), 'server.js']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (/\btp_(?:rulebooks|rulebook_versions|client_rulebooks)\b/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders.sort(), [path.join('lib', 'restore-check.js'), path.join('lib', 'tprm', 'rulebooks.js')].sort());
});
