'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'register-export-tests-password-1234';

let env;
let client;
let db;
let firmId;
let otherFirmId;
let consultant;
let stranger;
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

async function addParty(ws, name, { status = 'in_use', tier = null, services = [] } = {}) {
  const s = await signIn(consultant);
  const res = await s.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302, `${name} created`);
  const id = Number((String(res.location).match(/third-parties\/(\d+)/) || [])[1]);
  for (const svc of services) assert.equal((await s.post(`/tprm/clients/${ws}/third-parties/${id}/services`, svc)).status, 302);
  if (tier) {
    await db.prepare(`UPDATE tp_third_parties SET current_tier=?, tier_source='assessed', last_assessment_date='2026-01-10', next_due_date='2027-01-10'
      WHERE id=?`).run(tier, id);
  }
  return id;
}

async function tprmClient(name, { tprm = true } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  if (tprm) await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, consultant.id, 'consultant');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`rx-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
  const contributor = await makeUser(`rx-contrib-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'contributor' });
  return { id, owner, contributor };
}

function parse(text) {
  assert.equal(text.charCodeAt(0), 0xFEFF, 'starts with a UTF-8 byte order mark');
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const body = text.slice(1);
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\r' && body[i + 1] === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i += 1; }
    else cur += ch;
  }
  return rows;
}

const firmCsv = ws => `/tprm/clients/${ws}/register.csv`;
const clientCsv = ws => `/workspaces/${ws}/client-portal/third-party-risk/register.csv`;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  otherFirmId = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Other Export Firm')").run()).lastInsertRowid);
  consultant = await makeUser('rx-consultant@test.local');
  stranger = await makeUser('rx-stranger@test.local');
  outsider = await makeUser('rx-outsider@test.local', { role: 'manager', firm: otherFirmId });
  A = await tprmClient('Export Client A');
  B = await tprmClient('Export Client B');
  A.payroll = await addParty(A.id, 'Payroll Partner', { tier: 'high', services: [
    { description: 'Payroll processing', annual_spend: '1200', spend_currency: 'GBP' },
    { description: 'Pension admin', annual_spend: '300', spend_currency: 'GBP' },
  ] });
  A.formula = await addParty(A.id, '=HYPERLINK("http://evil.test","x")', { tier: 'low' });
  A.plus = await addParty(A.id, '+Plus, "Quoted" Ltd', { status: 'proposed' });
  A.ended = await addParty(A.id, 'Ended Vendor', { status: 'proposed' });
  await db.prepare("UPDATE tp_third_parties SET status='exited' WHERE id=?").run(A.ended);
  await addParty(B.id, 'B Only Supplier', { tier: 'medium' });
});

test.after(async () => {
  for (const s of sessions) await s.close();
  if (client) await client.close();
});

test('cells that a spreadsheet would run as formulas are neutralised and the rest are quoted correctly', () => {
  const { cell, csv } = require('../lib/tprm/register-export');
  for (const risky of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tTab', '\rCR']) assert.equal(cell(risky).replace(/^"|"$/g, '')[0], "'", risky);
  assert.equal(cell('Plain'), 'Plain');
  assert.equal(cell('a,b'), '"a,b"');
  assert.equal(cell('say "hi"'), '"say ""hi"""');
  assert.equal(cell('line\nbreak'), '"line\nbreak"');
  assert.equal(cell(null), '');
  assert.equal(cell(12), '12');
  const out = csv(['A', 'B'], [['x', '=y']]);
  assert.equal(out, "﻿A,B\r\nx,'=y\r\n");
});

test('the firm export holds the rows the register filters show, with the agreed columns', async () => {
  const s = await signIn(consultant);
  const page = await s.get(`/tprm/clients/${A.id}?tier=high`);
  assert.match(page.text, new RegExp(`href="${firmCsv(A.id)}\\?tier=high"[^>]*data-tprm-register-export`));

  const res = await s.get(firmCsv(A.id));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/csv; charset=utf-8/);
  assert.match(res.headers['content-disposition'], /attachment; filename="third-parties-Export-Client-A-\d{4}-\d{2}-\d{2}\.csv"/);
  const rows = parse(res.text);
  assert.deepEqual(rows[0], ['Name', 'Status', 'Tier', 'Tier source', 'Next review date', 'Due', 'Open assessment stage', 'Open findings',
    'Owner', 'Services', 'Annual spend']);
  const names = rows.slice(1).map(r => r[0]);
  assert.equal(names.length, 3, 'exited suppliers are hidden by default, as on the page');
  assert.ok(!names.includes('Ended Vendor'));
  assert.ok(names.includes(`'=HYPERLINK("http://evil.test","x")`), 'the formula name is prefixed with a quote');
  assert.ok(names.includes(`'+Plus, "Quoted" Ltd`));
  assert.ok(!names.some(n => /B Only Supplier/.test(n)), 'nothing from another client');
  const payroll = rows.find(r => r[0] === 'Payroll Partner');
  assert.equal(payroll[1], 'In use');
  assert.equal(payroll[2], 'High');
  assert.equal(payroll[3], 'Assessed');
  assert.equal(payroll[4], '2027-01-10');
  assert.match(payroll[5], /^Due /);
  assert.equal(payroll[6], 'None open');
  assert.equal(payroll[7], '0');
  assert.equal(payroll[9], 'Payroll processing; Pension admin');
  assert.equal(payroll[10], 'GBP 1500');

  const high = parse((await s.get(`${firmCsv(A.id)}?tier=high`)).text);
  assert.deepEqual(high.slice(1).map(r => r[0]), ['Payroll Partner']);
  const searched = parse((await s.get(`${firmCsv(A.id)}?q=plus`)).text);
  assert.equal(searched.length, 2);
  const all = parse((await s.get(`${firmCsv(A.id)}?status=all`)).text);
  assert.ok(all.slice(1).some(r => r[0] === 'Ended Vendor'));
  assert.ok(await db.prepare("SELECT 1 FROM audit_log WHERE action='tprm_register_exported' AND workspace_id=?").get(A.id));
});

test('the firm export is refused to anyone the register page refuses', async () => {
  assert.equal((await (await signIn(stranger)).get(firmCsv(A.id))).status, 404, 'a consultant not on the client');
  assert.equal((await (await signIn(outsider)).get(firmCsv(A.id))).status, 404, 'another firm');
  for (const who of [A.owner, A.contributor]) {
    const res = await (await signIn(who)).get(firmCsv(A.id));
    assert.ok([403, 404].includes(res.status), `a client user gets ${res.status}`);
    assert.doesNotMatch(res.text, /Payroll Partner/);
  }
});

test('the client export holds what the client list shows with the client filters, and only for that client', async () => {
  for (const who of [A.owner, A.contributor]) {
    const s = await signIn(who);
    const home = await s.get(`/workspaces/${A.id}/client-portal/third-party-risk?tier=high`);
    assert.match(home.text, new RegExp(`href="${clientCsv(A.id).replace(/\//g, '\\/')}\\?tier=high"[^>]*data-tprm-cv-export`));
    const res = await s.get(clientCsv(A.id));
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/csv/);
    const rows = parse(res.text);
    assert.deepEqual(rows[0], ['Third party', 'Service type', 'Tier', 'Stage', 'Decision', 'Residual risk', 'Open issues', 'Conditions done', 'Next review', 'Owner']);
    const names = rows.slice(1).map(r => r[0]);
    assert.equal(names.length, 3);
    assert.ok(names.includes(`'=HYPERLINK("http://evil.test","x")`));
    assert.ok(!names.includes('Ended Vendor'));
    const high = parse((await s.get(`${clientCsv(A.id)}?tier=high`)).text);
    assert.deepEqual(high.slice(1).map(r => r[0]), ['Payroll Partner']);
    const ended = parse((await s.get(`${clientCsv(A.id)}?tab=ended`)).text);
    assert.deepEqual(ended.slice(1).map(r => r[0]), ['Ended Vendor']);
  }
  const otherClient = await signIn(B.owner);
  assert.equal((await otherClient.get(clientCsv(A.id))).status, 403);
  const own = parse((await otherClient.get(clientCsv(B.id))).text);
  assert.deepEqual(own.slice(1).map(r => r[0]), ['B Only Supplier']);
  assert.equal((await client.get(clientCsv(A.id))).status, 404, 'a firm user does not get the client export');
  const iso = await tprmClient('Export ISO Only', { tprm: false });
  assert.equal((await (await signIn(iso.owner)).get(clientCsv(iso.id))).status, 404);
});
