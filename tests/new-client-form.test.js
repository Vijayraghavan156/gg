'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient } = require('./helpers');

let env;
let client;

test.before(async () => {
  env = await bootClient();
  client = env.client;
});

test.after(async () => { if (client) await client.close(); });

function fieldNames(html) {
  const names = new Set();
  for (const m of html.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"/g)) {
    if (m[1] !== '_csrf') names.add(m[1]);
  }
  return [...names].sort();
}

test('the new-client modal asks for the same fields as the page shown when it is refused', async () => {
  const dashboard = await client.get('/dashboard');
  assert.equal(dashboard.status, 200);
  const dialog = dashboard.text.slice(dashboard.text.indexOf('<dialog id="newWs"'), dashboard.text.indexOf('</dialog>'));
  assert.ok(dialog.length > 0, 'the dashboard has the new-client modal');

  const refused = await client.post('/workspaces', { client_name: 'No Service Client', industry: 'Retail', scope: 'Head office only' });
  assert.equal(refused.status, 400);
  const form = refused.text.slice(refused.text.indexOf('<form method="POST" action="/workspaces"'));
  const page = form.slice(0, form.indexOf('</form>'));
  assert.match(page, /Choose at least one service/);
  assert.match(page, />Head office only<\/textarea>/, 'the refused page keeps what was typed');

  assert.deepEqual(fieldNames(dialog), fieldNames(page));
  assert.ok(fieldNames(dialog).includes('scope'), 'the modal has the scope field');
});

test('the new-client modal checks for a service itself and does not promise ISO scoping questions', async () => {
  const dashboard = await client.get('/dashboard');
  const dialog = dashboard.text.slice(dashboard.text.indexOf('<dialog id="newWs"'), dashboard.text.indexOf('</dialog>'));
  assert.match(dialog, /id="dashboard-service-error"[^>]*role="alert"[^>]*hidden/);
  assert.doesNotMatch(dialog, /25 scoping questions/);
  assert.match(dashboard.text, /getElementById\('dashboard-service-error'\)/);
});
