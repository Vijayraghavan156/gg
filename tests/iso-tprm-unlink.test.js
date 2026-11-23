'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootClient } = require('./helpers');

const SUPPLIER_CONTROLS = ['annex-a.5.19', 'annex-a.5.20', 'annex-a.5.21', 'annex-a.5.22'];

let env;
let client;
let db;
let wsId;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  const firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  const leadId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
  wsId = Number((await db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,scope,lead_consultant_id,frameworks,engagement_outcome)
    VALUES (?,'Unlinked ISO Client','ISO scope for the unlink regression',?,'["iso27001"]','certification_support')`)
    .run(firmId, leadId)).lastInsertRowid);
});

test.after(async () => { if (client) await client.close(); });

async function setSupplierControls(applicability, status) {
  for (const ref of SUPPLIER_CONTROLS) {
    const req = await db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
      WHERE f.code='iso27001' AND rq.ref=?`).get(ref);
    assert.ok(req, `${ref} requirement exists`);
    await db.prepare(`INSERT INTO control_instances (workspace_id,requirement_id,entity_id,applicability,status)
      VALUES (?,?,NULL,?,?)
      ON CONFLICT (workspace_id, requirement_id) WHERE entity_id IS NULL
      DO UPDATE SET applicability=EXCLUDED.applicability, status=EXCLUDED.status`)
      .run(wsId, req.id, applicability, status);
  }
}

async function supplierItem() {
  const { computeRoadmap } = require('../lib/readiness');
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  const roadmap = await computeRoadmap(ws, { stateRows: [], assetCount: 0, riskCount: 0, ncOpen: 0 });
  const item = roadmap.find(r => r.key === 'suppliers');
  assert.ok(item, 'the ISO readiness item "Manage supplier security operationally" is kept');
  return item;
}

test('the readiness and overview pages carry no third-party risk link', async () => {
  for (const route of [`/workspaces/${wsId}/readiness`, `/workspaces/${wsId}`]) {
    const res = await client.get(route);
    assert.equal(res.status, 200, `${route} renders`);
    assert.doesNotMatch(res.text, /href="\/tprm/, `${route} does not link to /tprm`);
  }
});

test('the supplier readiness item is progressed through A.5.19–A.5.22, not third-party data', async () => {
  let item = await supplierItem();
  assert.equal(item.label, 'Manage supplier security operationally');
  assert.equal(item.clause, 'Clause 8.1 + A.5.19–A.5.22');
  assert.equal(item.link, `/workspaces/${wsId}/controls`);
  assert.doesNotMatch(item.link, /tprm/);
  assert.notEqual(item.link_label, 'Third-party risk');
  assert.equal(item.done, false, 'undecided supplier controls are not done');
  assert.match(item.detail, /0 \/ 4 supplier controls/);

  await setSupplierControls('applicable', 'partially_implemented');
  item = await supplierItem();
  assert.equal(item.done, false);
  assert.equal(item.partial, true, 'included controls under way show as partial');

  await setSupplierControls('applicable', 'implemented');
  item = await supplierItem();
  assert.equal(item.done, true, 'done once every included supplier control is Implemented');
  assert.match(item.detail, /4 \/ 4 included supplier controls/);

  await setSupplierControls('excluded', 'not_applicable');
  item = await supplierItem();
  assert.equal(item.done, true, 'a justified SoA exclusion of all four controls completes the item');
  assert.match(item.detail, /excluded in the SoA/);
});

test('the assurance report types no longer offer the supplier report', async () => {
  const reports = require('../lib/assurance-reports');
  assert.deepEqual(Object.keys(reports.REPORTS).sort(), ['audit_readiness', 'executive_posture']);
  const builder = await client.get(`/workspaces/${wsId}/assurance/new`);
  assert.equal(builder.status, 200);
  assert.doesNotMatch(builder.text, /supplier_due_diligence|due-diligence|name="supplier_id"/i);
  const definitions = await db.prepare('SELECT report_key FROM assurance_report_definitions ORDER BY report_key').all();
  assert.deepEqual(definitions.map(d => d.report_key), ['audit_readiness', 'executive_posture']);
  const systemTemplates = await db.prepare('SELECT name FROM report_templates WHERE is_system=1').all();
  assert.ok(!systemTemplates.some(t => /supplier/i.test(t.name)), 'no seeded supplier report template');
});

test('the third-party data stub is gone', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'lib', 'third-party-data.js')), false);
});

const TP_TABLE = /\btp_(?:client_settings|events|third_parties|services|assessments|evidence|findings|recommendations|conditions|client_decisions|criticality_models|import_batches|question_bank_versions|questionnaires|vendor_requests|answers|answer_evidence|clarifications|firm_settings|ai_reviews|ai_suggestions|ai_suggestion_evidence|condition_proofs|condition_proof_files|trigger_events|contract_reviews|letterheads|rulebooks|rulebook_versions|client_rulebooks|assurance_reports)\b/;

function sourceFiles(dir) {
  const root = path.join(__dirname, '..', dir);
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(?:js|ejs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('a client with both services: ISO screens carry no TPRM link, TPRM pages carry no ISO navigation', async () => {
  const both = Number((await db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,scope,lead_consultant_id,frameworks,engagement_outcome)
    SELECT firm_id,'Both Services Unlink Client','ISO scope and third-party risk',lead_consultant_id,'["iso27001"]','certification_support'
    FROM workspaces WHERE id=?`).run(wsId)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(both);

  for (const route of [`/workspaces/${both}?skipSetupRedirect=1`, `/workspaces/${both}/readiness`, `/workspaces/${both}/controls`,
    `/workspaces/${both}/soa`, `/workspaces/${both}/risks`, `/workspaces/${both}/client-portal`, `/workspaces/${both}/setup`]) {
    const res = await client.get(route);
    assert.equal(res.status, 200, `${route} renders`);
    assert.doesNotMatch(res.text, /href="\/tprm\/clients/, `${route} does not link to a TPRM client page`);
    assert.doesNotMatch(res.text, /href="\/workspaces\/\d+\/tprm/, `${route} has no workspace TPRM link`);
    assert.doesNotMatch(res.text, /client-portal\/third-party-risk/, `${route} has no portal TPRM link for firm users`);
  }

  for (const route of ['/tprm', `/tprm/clients/${both}`]) {
    const res = await client.get(route);
    assert.equal(res.status, 200, `${route} renders`);
    assert.doesNotMatch(res.text, new RegExp(`href="/workspaces/${both}/(?:controls|soa|readiness|risks|gap-assessment|documents|evidence)"`),
      `${route} does not render the ISO workspace sidebar`);
  }
});

test('the ISO workspace routes use TPRM code only to switch the service on for a new client', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'routes', 'workspaces.js'), 'utf8');
  const imports = [...text.matchAll(/require\(['"]\.\.\/lib\/tprm\/([^'"]+)['"]\)/g)].map(m => m[1]);
  assert.deepEqual(imports, ['settings'], 'workspaces.js imports only lib/tprm/settings');
  const calls = [...text.matchAll(/\btpSettings\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual(calls, ['enableOnCreate'], 'and calls only enableOnCreate, once');
  const create = text.slice(text.indexOf("app.post('/workspaces',"), text.indexOf("app.get('/workspaces/:wsId/setup'"));
  assert.match(create, /tpSettings\.enableOnCreate\(/, 'inside the create-client handler');
  for (const view of ['workspace.ejs', 'workspace_unassigned.ejs']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', view), 'utf8');
    assert.doesNotMatch(html, /tp_enabled|tp_present|tpEnabled/, `${view} has no TPRM switch and reads no TPRM state`);
  }
});

test('only the TPRM area and the client service switch reach TPRM code or tables', () => {
  const allowedTableReaders = new Set([path.join('routes', 'third-party-risk.js'), path.join('lib', 'restore-check.js')]);
  allowedTableReaders.add(path.join('lib', 'workspace-deletion.js'));
  const allowedTprmImports = new Set([path.join('routes', 'third-party-risk.js'), path.join('routes', 'tprm-settings.js'),
    path.join('routes', 'workspaces.js'), 'server.js']);
  allowedTprmImports.add(path.join('routes', 'tprm-register.js'));
  allowedTprmImports.add(path.join('routes', 'tprm-assessments.js'));
  allowedTprmImports.add(path.join('routes', 'tprm-evidence.js'));
  allowedTprmImports.add(path.join('routes', 'tprm-recommendations.js'));
  allowedTprmImports.add(path.join('routes', 'tprm-questionnaires.js'));
  allowedTprmImports.add(path.join('routes', 'tprm-vendor.js'));
  allowedTprmImports.add(path.join('routes', 'tprm-ai-review.js'));
  allowedTprmImports.add(path.join('routes', 'tprm-conditions.js'));
  ['tprm-reassessment.js', 'tprm-contract-review.js'].forEach(f => allowedTprmImports.add(path.join('routes', f)));
  allowedTprmImports.add(path.join('routes', 'tprm-report.js'));
  allowedTprmImports.add(path.join('routes', 'tprm-rulebooks.js'));
  allowedTprmImports.add(path.join('routes', 'tprm-relationships.js'));
  for (const file of [...sourceFiles('routes'), ...sourceFiles('lib'), ...sourceFiles('views'), 'server.js', 'db.js']) {
    if (file.startsWith(path.join('lib', 'tprm') + path.sep)) continue;
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    if (!allowedTableReaders.has(file)) assert.doesNotMatch(text, TP_TABLE, `${file} must not read tp_* tables`);
    if (!allowedTprmImports.has(file)) assert.doesNotMatch(text, /lib\/tprm\//, `${file} must not use the TPRM libraries`);
    const firmMenu = file === path.join('views', 'partials', 'header.ejs');
    if (!firmMenu && !/^views\/tprm_/.test(file.split(path.sep).join('/'))) {
      assert.doesNotMatch(text, /href="\/tprm/, `${file} must not link to the TPRM area`);
    }
  }
});
