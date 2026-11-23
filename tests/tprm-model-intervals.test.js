'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { bootClient } = require('./helpers');

let env;
let client;
let db;
let crit;
let placement;
let firmId;
let manager;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  crit = require('../lib/tprm/criticality');
  placement = require('../lib/tprm/placement');
  firmId = Number((await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id);
  manager = await db.prepare('SELECT * FROM users WHERE email=?').get(env.login.email);
});

test.after(async () => { if (client) await client.close(); });

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'[]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  return id;
}

async function today(ws) {
  const { todayFor } = require('../lib/dates');
  return todayFor(await db.prepare('SELECT * FROM workspaces WHERE id=?').get(ws));
}

const due = (last, months, now) => { const d = placement.addMonths(last, months); return d > now ? d : now; };

async function activateIntervals(intervals) {
  const { model } = await crit.createDraft(db, manager);
  await crit.saveDraft(db, manager, model.id, { questions: model.questions, intervals, rowVersion: model.rowVersion });
  const saved = await crit.getVersion(db, firmId, model.id);
  return (await crit.activateDraft(db, manager, saved.id, { rowVersion: saved.rowVersion })).model;
}

function multipart(token, content) {
  const boundary = '----tprm' + crypto.randomBytes(8).toString('hex');
  const body = [`--${boundary}`, 'Content-Disposition: form-data; name="_csrf"', '', token,
    `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="tp.csv"', 'Content-Type: text/csv', '', content,
    `--${boundary}--`, ''].join('\r\n');
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

test('due dates follow the active model\'s intervals, with the client override on top', async () => {
  const active = await activateIntervals({ Critical: 3, High: 5, Medium: 7, Low: 9 });
  assert.equal(active.status, 'active');
  assert.equal(active.version, 2);

  const ws = await tprmClient('Model Intervals Client');
  const set = await client.post(`/tprm/clients/${ws}/settings`, {
    label: ['Tier 1', 'Tier 2', 'Tier 3'], tier: ['critical', 'high', 'low'], interval_months_low: '2', row_version: '1',
  });
  assert.equal(set.status, 302);
  const now = await today(ws);
  const last = placement.addMonths(now, -1);

  const settingsPage = await client.get(`/tprm/clients/${ws}/settings`);
  assert.match(settingsPage.text, /Firm default 5 months/, 'the settings page shows the model\'s intervals as the firm default');
  assert.doesNotMatch(settingsPage.text, /Firm default 36 months/);

  const add = async (name, label) => {
    const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use', client_label: label, last_assessment_date: last });
    assert.equal(res.status, 302);
    const id = Number(String(res.location).match(/third-parties\/(\d+)/)[1]);
    return (await db.prepare('SELECT current_tier, next_due_date::text AS due FROM tp_third_parties WHERE id=?').get(id));
  };
  assert.deepEqual(await add('High From Model', 'Tier 2'), { current_tier: 'high', due: due(last, 5, now) }, 'High uses the model\'s 5 months');
  assert.deepEqual(await add('Critical From Model', 'Tier 1'), { current_tier: 'critical', due: due(last, 3, now) });
  assert.deepEqual(await add('Low Override', 'Tier 3'), { current_tier: 'low', due: due(last, 2, now) }, 'the client\'s Low override (2) wins over the model (9)');

  await client.get(`/tprm/clients/${ws}/import`);
  const form = multipart(client.getCsrfToken(), `name,status,last_assessment_date,client_label\nImported High,in_use,${last},Tier 2\n`);
  const preview = await client.post(`/tprm/clients/${ws}/import/preview`, form.body, { headers: form.headers, csrf: false });
  assert.equal(preview.status, 200);
  const batch = preview.text.match(/name="batch_id" value="(\d+)"/)[1];
  const csv = preview.text.match(/<textarea name="csv"[^>]*>\n([\s\S]*?)<\/textarea>/)[1];
  const commit = await client.post(`/tprm/clients/${ws}/import/commit`, { batch_id: batch, csv });
  assert.equal(commit.status, 302);
  const imported = await db.prepare(`SELECT next_due_date::text AS due FROM tp_third_parties WHERE workspace_id=? AND name='Imported High'`).get(ws);
  assert.equal(imported.due, due(last, 5, now), 'the import uses the model intervals too');
});
