'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { normalizeDisplayPunctuation } = require('../lib/typography');

const DASH = String.fromCodePoint(0x2014);
const ENTITY = '&' + 'mdash;';

test('display text loses its em dashes but attribute values and form contents keep them', () => {
  const html = [
    `<h1>Cloud ${DASH} hosting</h1>`,
    `<select name="service"><option value="Cloud ${DASH} hosting" selected>Cloud ${DASH} hosting</option></select>`,
    `<input class="input" name="business_unit" value="Ops ${DASH} EMEA">`,
    `<textarea name="note">Line ${DASH} one ${ENTITY} two</textarea>`,
    `<a href="?service=Cloud ${DASH} hosting" title="A ${DASH} B">Link ${DASH} text</a>`,
    `<script>const s = "a ${DASH} b";</script>`,
    `<style>.x::after { content: "${DASH}"; }</style>`,
    `<pre>pre ${DASH} kept <code>code ${DASH} kept</code></pre>`,
    `<p>after ${ENTITY} pre</p>`,
    `<select name="plain"><option>Raw ${DASH} label</option><option value="v">Shown ${DASH} label</option></select>`,
    `<!-- note ${DASH} kept -->`,
    `<p>1 < 2 ${DASH} true</p>`,
  ].join('\n');
  const out = normalizeDisplayPunctuation(html);
  assert.match(out, /<h1>Cloud - hosting<\/h1>/);
  assert.ok(out.includes(`<option value="Cloud ${DASH} hosting" selected>Cloud - hosting</option>`), 'the option value is kept, its label is display text');
  assert.ok(out.includes(`value="Ops ${DASH} EMEA"`), 'an input value is kept');
  assert.ok(out.includes(`<textarea name="note">Line ${DASH} one ${ENTITY} two</textarea>`), 'textarea contents are kept');
  assert.ok(out.includes(`href="?service=Cloud ${DASH} hosting" title="A ${DASH} B">Link - text</a>`), 'attributes are kept, the link text is not');
  assert.ok(out.includes(`const s = "a ${DASH} b";`), 'script contents are kept');
  assert.ok(out.includes(`content: "${DASH}";`), 'style contents are kept');
  assert.ok(out.includes(`<pre>pre ${DASH} kept <code>code ${DASH} kept</code></pre>`), 'pre and code are kept');
  assert.match(out, /<p>after - pre<\/p>/, 'text after a closed pre is display text again');
  assert.ok(out.includes(`<option>Raw ${DASH} label</option>`), 'an option without a value submits its text, so it is kept');
  assert.ok(out.includes('<option value="v">Shown - label</option>'));
  assert.ok(out.includes(`<!-- note ${DASH} kept -->`));
  assert.match(out, /<p>1 < 2 - true<\/p>/);
});

test('a page without an em dash is returned as it is', () => {
  const html = '<p>No dashes - here</p><input value="x">';
  assert.equal(normalizeDisplayPunctuation(html), html);
  assert.equal(normalizeDisplayPunctuation(null), null);
});

test('rewriting a large page stays fast', () => {
  const row = `<tr><td>Name ${DASH} one</td><td><input name="a" value="v ${DASH} w"></td><td><select><option value="x">X ${DASH} y</option></select></td></tr>`;
  const html = `<table>${row.repeat(20000)}</table>`;
  const started = process.hrtime.bigint();
  const out = normalizeDisplayPunctuation(html);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(out.includes(`value="v ${DASH} w"`));
  assert.ok(ms < 1000, `took ${ms} ms`);
});

let env;
let client;
let db;
let firmId;

const PASSWORD = 'typography-forms-password-1234';

async function routesReady() {
  if (env) return;
  const { bootClient } = require('./helpers');
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
}

test.after(async () => { if (client) await client.close(); });

async function tpOnlyWorkspace(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'[]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  return id;
}

async function signInClient(email, workspaceId) {
  const { makeClient } = require('./helpers');
  await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active) VALUES (?,?,?,'client',1)`)
    .run(email, bcrypt.hashSync(PASSWORD, 4), email);
  const id = (await db.prepare('SELECT id FROM users WHERE email=?').get(email)).id;
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, 'client_owner');
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302);
  return session;
}

const decode = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('the client service-type filter submits the stored service type and finds its third parties', async () => {
  await routesReady();
  const ws = await tpOnlyWorkspace('Dash Filter Client');
  const category = `Cloud ${DASH} hosting`;
  await db.prepare("INSERT INTO tp_third_parties (workspace_id, name, status, category) VALUES (?, 'Dashline Hosting', 'in_use', ?)").run(ws, category);
  await db.prepare("INSERT INTO tp_third_parties (workspace_id, name, status, category) VALUES (?, 'Plain Payroll', 'in_use', 'Payroll')").run(ws);
  const session = await signInClient('dash-filter-client@test.local', ws);
  try {
    const base = `/workspaces/${ws}/client-portal/third-party-risk`;
    const home = await session.get(`${base}?tab=all`);
    assert.equal(home.status, 200);
    const select = (home.text.match(/<select[^>]*name="service"[^>]*>[\s\S]*?<\/select>/) || [''])[0];
    const values = [...select.matchAll(/<option value="([^"]*)"/g)].map(m => decode(m[1]));
    assert.ok(values.includes(category), `the option submits the stored value, got ${JSON.stringify(values)}`);

    const filtered = await session.get(`${base}?${new URLSearchParams({ tab: 'all', service: category })}`);
    assert.equal(filtered.status, 200);
    const list = filtered.text.slice(filtered.text.indexOf('data-tprm-portal-list'));
    assert.match(list, /Dashline Hosting/, 'the filter finds the third party');
    assert.doesNotMatch(list, /Plain Payroll/, 'and only that one');
    assert.match(filtered.text, /data-tprm-cv-count>1 third party</);
    const chosen = (filtered.text.match(/<option value="([^"]*)" selected>/g) || []).map(s => decode(s));
    assert.ok(chosen.some(s => s.includes(category)), 'the chosen service type stays selected');
  } finally {
    await session.close();
  }
});

test('an edit form shows a saved em dash as it is, so saving it does not turn it into a hyphen', async () => {
  await routesReady();
  const ws = await tpOnlyWorkspace('Dash Edit Client');
  const name = `Northgate ${DASH} Logistics`;
  const tp = Number((await db.prepare("INSERT INTO tp_third_parties (workspace_id, name, status, category) VALUES (?, ?, 'in_use', 'Freight')").run(ws, name)).lastInsertRowid);
  const page = await client.get(`/tprm/clients/${ws}/third-parties/${tp}/edit`);
  assert.equal(page.status, 200);
  const input = (page.text.match(/<input[^>]*name="name"[^>]*>/) || [''])[0];
  assert.ok(decode(input).includes(`value="${name}"`), `the name field keeps the em dash: ${input}`);
});

test('the delete-client dialog accepts the name as it reads on the page, hyphen or em dash', async () => {
  await routesReady();
  const vm = require('node:vm');
  const name = `Dash Delete ${DASH} Client`;
  await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome) VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name);
  const page = await client.get('/dashboard');
  assert.equal(page.status, 200);
  assert.ok(decode(page.text).includes(`data-delete-client-name="${name}"`), 'the button carries the stored name');
  assert.match(page.text, /Dash Delete - Client/, 'the name reads with a hyphen');
  const source = (page.text.match(/const readableName = (name => [^;]+);/) || [])[1];
  assert.ok(source, 'the dialog shows and expects the name as the page reads it');
  const readableName = vm.runInNewContext(source);
  assert.equal(readableName(name), 'Dash Delete - Client', 'typing or copying the name as shown passes the check');
  assert.match(page.text, /currentName = readableName\(clientName\)/);
  assert.match(page.text, /input\.value\.trim\(\) !== currentName/, 'the exact-name check stays');
});
