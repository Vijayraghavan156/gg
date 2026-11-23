'use strict';

// public/app.css locks html and body (overflow: hidden) because the app shell
// scrolls its own content pane. A page that loads app.css without the shell
// (vendor links, the public acknowledgement page) must opt back into document
// scrolling with <html class="page-standalone">, or a long page cannot scroll.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');

function viewFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return viewFiles(p);
    return e.name.endsWith('.ejs') ? [p] : [];
  });
}

test('app.css keeps the shell lock and provides the standalone opt-out', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  assert.match(css, /html, body \{[^}]*overflow: hidden/);
  assert.match(css, /html\.page-standalone, html\.page-standalone body \{[^}]*overflow-y: auto/);
});

test('every page that loads app.css without the app shell can scroll', () => {
  const standalone = [];
  for (const file of viewFiles(VIEWS)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/href="\/app\.css/.test(src)) continue;
    if (/<html\b/.test(src) && !/class="app"/.test(src)) {
      standalone.push(path.relative(ROOT, file));
      assert.match(src, /<html[^>]*class="[^"]*\bpage-standalone\b/, `${path.relative(ROOT, file)} needs <html class="page-standalone">`);
    }
  }
  for (const v of ['views/tprm_vendor_questionnaire.ejs', 'views/tprm_vendor_conditions.ejs', 'views/tprm_vendor_link.ejs', 'views/public_ack.ejs']) {
    assert.ok(standalone.includes(v), `${v} is checked`);
  }
});
