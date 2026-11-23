'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const rulesLib = require('../lib/tprm/answer-rules');
const va = require('../lib/tprm/vendor-answers');
const sheet = require('../lib/tprm/vendor-sheet');

const ROW = { answer_type: 'yes_no_na', fields_on: 'yes', fields: [{ key: 'methods', label: 'Methods allowed', kind: 'multi', options: ['Authenticator app', 'Hardware key', 'SMS'] }] };
const rules = rulesLib.questionRules(ROW);
const parse = f => va.parseAnswerForm({ r: { 'IAM-02': 'yes' }, f: { 'IAM-02': { methods: f } } }, [], ['IAM-02'], () => rules).posted.get('IAM-02');

test('a tick-box field keeps the ticked choices in the order of the list, whether ticked on the page or typed in the spreadsheet', () => {
  assert.equal(rules.fields[0].kind, 'multi');
  assert.deepEqual(rules.fields[0].options, ['Authenticator app', 'Hardware key', 'SMS']);
  assert.deepEqual(parse(['', 'SMS', 'Authenticator app']).fields, { methods: 'Authenticator app; SMS' });
  assert.equal(parse(['', 'SMS', 'Authenticator app']).detail, 'Methods allowed: Authenticator app; SMS');
  assert.deepEqual(parse('SMS; Authenticator app').fields, { methods: 'Authenticator app; SMS' }, 'the spreadsheet form gives the same value');
  assert.deepEqual(parse(['']).fields, {}, 'ticking nothing clears it');
  assert.throws(() => parse(['Fax']), /"Fax" is not one of the choices/);
  assert.equal(va.answerHash({ response: 'yes', fields: parse(['SMS', 'Authenticator app']).fields }), va.answerHash({ response: 'yes', fields: { methods: 'Authenticator app; SMS' } }));
});

test('a field marked as tick-box without choices is an ordinary text field, and choices may not contain the separator', () => {
  assert.equal(rulesLib.questionRules({ ...ROW, fields: [{ key: 'm', label: 'M', kind: 'multi' }] }).fields[0].kind, 'short');
  assert.deepEqual(rulesLib.questionRules({ ...ROW, fields: [{ key: 'm', label: 'M', kind: 'multi', options: ['A; B', 'C'] }] }).fields[0].options, ['C']);
});

test('the page shows one tick box per choice, with the saved ones ticked and a marker so that none ticked is saved too', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'partials', 'tprm_vendor_field.ejs'), { q: { id: 'IAM-02' }, f: rules.fields[0], fv: 'Authenticator app; SMS' });
  assert.match(html, /<input type="hidden" name="f\[IAM-02\]\[methods\]\[\]" value="">/);
  assert.match(html, /value="Authenticator app" checked/);
  assert.match(html, /value="Hardware key">/);
  assert.match(html, /value="SMS" checked/);
  assert.match(html, /tick all that apply/);
});

test('the spreadsheet names the choices on the field row', () => {
  const rows = sheet.rowsFor({ sections: [{ title: 'IAM', questions: [{ id: 'IAM-02', question: 'MFA?', rules, answer: null, version: 'x' }] }] });
  assert.match(rows[1].cells[2], /any of: Authenticator app; Hardware key; SMS/);
});

test('ticked boxes arrive from a real multipart form as a list, with the empty marker first', async () => {
  const express = require('express');
  const multer = require('multer');
  const http = require('node:http');
  const app = express();
  app.post('/t', multer().any(), (req, res) => res.json(req.body));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const boundary = '----t' + Date.now();
  const part = (k, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  const body = part('r[IAM-02]', 'yes') + part('f[IAM-02][methods][]', '') + part('f[IAM-02][methods][]', 'SMS') + part('f[IAM-02][methods][]', 'Hardware key') + `--${boundary}--\r\n`;
  const json = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/t', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject); req.end(body);
  });
  server.close();
  assert.deepEqual(json.f['IAM-02'].methods, ['', 'SMS', 'Hardware key']);
  const posted = va.parseAnswerForm(json, [], ['IAM-02'], () => rules).posted.get('IAM-02');
  assert.deepEqual(posted.fields, { methods: 'Hardware key; SMS' });
});

test('the third party sees one plain word for each stage, and never the client\'s decision', () => {
  const { reviewStatus } = require('../lib/tprm/vendor-portal');
  const expected = {
    scoping: 'Under review', tier_proposed: 'Under review', tier_confirmed: 'Under review', recommendation_draft: 'Under review',
    recommendation_in_review: 'Under review', information_requested: 'Under review', recommendation_issued: 'Closed', completed: 'Closed',
  };
  for (const [status, word] of Object.entries(expected)) assert.equal(reviewStatus(status, 'submitted', false), word, status);
  assert.equal(reviewStatus('tier_confirmed', 'in_progress', true), 'In progress');
  assert.equal(reviewStatus('tier_confirmed', 'draft', false), 'Not started');
  assert.equal(reviewStatus('completed', 'in_progress', true), 'Closed');
  const views = ['tprm_vendor_home.ejs', 'tprm_vendor_questionnaire.ejs', 'tprm_vendor_issues.ejs', 'tprm_vendor_files.ejs'];
  for (const v of views) assert.doesNotMatch(require('node:fs').readFileSync(path.join(__dirname, '..', 'views', v), 'utf8'), /Approved/, v);
});
