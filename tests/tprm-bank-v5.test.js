'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tprm-question-bank.json'), 'utf8'));
const Q = id => BANK.questions.find(q => q.id === id);
const READ_BY_ID = ['AIS-01', 'FTP-01', 'FTP-02', 'FTP-03', 'FTP-04', 'FTP-05', 'FTP-06', 'FTP-07', 'PRM-06', 'GDP-04', 'FIN-03',
  'DOR-06', 'DOR-07', 'PFR-02', 'RBI-02', 'SEB-05', 'UAE-01', 'UAE-02', 'SAM-01'];

test('bank version 5: every question once, the two answer types only, fields that fit their question', () => {
  assert.match(BANK.version, /version 5/);
  const ids = BANK.questions.map(q => q.id);
  assert.equal(new Set(ids).size, ids.length, 'every id once');
  for (const q of BANK.questions) {
    assert.ok(['yes_no_na', 'free_text'].includes(q.answer_type), `${q.id}: answer type`);
    if (q.fields) {
      assert.ok(Array.isArray(q.fields) && q.fields.length >= 1 && q.fields.length <= 5, `${q.id}: one to five fields`);
      assert.equal(new Set(q.fields.map(f => f.key)).size, q.fields.length, `${q.id}: field keys unique`);
      for (const f of q.fields) {
        assert.match(f.key, /^[a-z0-9_]{1,40}$/, `${q.id}: field key`);
        assert.ok(['short', 'long', 'date', 'number'].includes(f.kind), `${q.id}: field kind`);
        assert.ok(f.label && f.label.length <= 80, `${q.id}: field label`);
      }
      assert.equal(q.fields_on, q.answer_type === 'free_text' ? 'answer' : 'yes', `${q.id}: fields on the answer of a written question, on Yes otherwise`);
      assert.ok(!q.details_on_yes, `${q.id}: fields or a Details box, not both`);
    }
    if (q.details_on_yes) assert.equal(q.answer_type, 'yes_no_na', `${q.id}: Details on Yes only on a Yes/No question`);
  }
});

test('bank version 5: a Yes/No question whose guidance lists what a good answer includes has somewhere to write it', () => {
  for (const q of BANK.questions) {
    if (q.answer_type !== 'yes_no_na' || !/^A good answer includes:/.test(q.guidance || '')) continue;
    assert.ok(q.fields || q.details_on_yes, `${q.id}: fields or a Details box for its guidance`);
  }
});

test('bank version 5: the answers the app reads by id keep their shape', () => {
  for (const id of READ_BY_ID) {
    const q = Q(id);
    assert.ok(q, id);
    assert.ok(!q.fields && !q.details_on_yes, `${id}: no fields`);
  }
  assert.equal(Q('RBI-02').answer_type, 'yes_no_na');
  assert.equal(Q('FTP-01').answer_type, 'free_text');
});

test('bank version 5: documents: no contract, no samples; one name for one real document', () => {
  for (const q of BANK.questions) {
    if (!q.evidence) {
      assert.equal(q.evidence_mandatory, false, `${q.id}: no document asked, none required`);
      assert.ok(!q.document, `${q.id}: no document name without a request`);
      continue;
    }
    assert.doesNotMatch(q.evidence, /contract clause|executed|signed contract|written commitment|\bclause\b|\bsample\b|screenshot|export of/i, `${q.id}: ${q.evidence}`);
    assert.ok(q.document && q.document.name && q.document.group, `${q.id}: a document name and group`);
  }
  const policy = BANK.questions.filter(q => q.document && q.document.name === 'Information security policy').length;
  assert.ok(policy >= 20, 'the policy questions share one document');
});

test('bank version 5: every acronym has a plain meaning; no dashes anywhere', () => {
  for (const q of BANK.questions) for (const t of q.acronyms || []) assert.ok(BANK.glossary[t], `${q.id}: ${t} in the glossary`);
  assert.doesNotMatch(JSON.stringify(BANK), /[–—]/);
});

const rulesLib = require('../lib/tprm/answer-rules');
const vendorAnswers = require('../lib/tprm/vendor-answers');
const V4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tprm-question-bank-v4.json'), 'utf8'));
const RULES = vendorAnswers.rulesMap(BANK, 'Acme Bank');
const rulesOf = id => RULES.get(id);
const parse = (body, ids) => vendorAnswers.parseAnswerForm(body, [], ids, rulesOf);

test('answer fields: the labels carry the client\'s name; a written question\'s fields become its answer', () => {
  assert.match(RULES.get('CLM-12').fields.map(f => f.label).join('|'), /reaches Acme Bank/);
  assert.match(RULES.get('CLM-06').detailsOnYes, /Acme Bank can supply/);
  assert.match(rulesLib.questionRules(Q('CLM-12')).fields.map(f => f.label).join('|'), /<Client>/, 'without a name the bank text is kept');
  const parsed = parse({ f: { 'GOV-01': { review_frequency: 'Yearly', approver: 'The board', current_version: '4.2', last_review_date: '2026-03-01' } } }, ['GOV-01']);
  const v = parsed.posted.get('GOV-01');
  assert.equal(v.response, 'text');
  assert.deepEqual(v.fields, { review_frequency: 'Yearly', approver: 'The board', current_version: '4.2', last_review_date: '2026-03-01' });
  assert.equal(v.detail, 'How often the policy is reviewed: Yearly\nWho approves the policy: The board\nCurrent version: 4.2\nDate of last review: 1 Mar 2026');
  const na = parse({ r: { 'GOV-01': 'na' }, d: { 'GOV-01': 'No policy of ours applies' }, f: { 'GOV-01': { approver: 'left over' } } }, ['GOV-01']).posted.get('GOV-01');
  assert.deepEqual([na.response, na.fields, na.detail], ['na', null, 'No policy of ours applies']);
});

test('answer fields: fields and Details on a Yes; nothing kept on a No', () => {
  const yes = parse({ r: { 'GOV-02': 'yes' }, f: { 'GOV-02': { name: 'A. Rao', title: 'CISO', reporting_line: 'CEO', date_appointed: '2024-05-01' } } }, ['GOV-02']).posted.get('GOV-02');
  assert.equal(yes.response, 'yes');
  assert.equal(yes.detail, 'Name: A. Rao\nTitle: CISO\nReporting line: CEO\nDate appointed: 1 May 2024');
  const no = parse({ r: { 'GOV-02': 'no' }, d: { 'GOV-02': 'Being recruited' }, f: { 'GOV-02': { name: 'left over' } } }, ['GOV-02']).posted.get('GOV-02');
  assert.deepEqual([no.response, no.fields, no.detail], ['no', null, 'Being recruited']);
  const details = parse({ r: { 'IAM-01': 'yes' }, y: { 'IAM-01': 'Ticket, manager approval, then IT' } }, ['IAM-01']).posted.get('IAM-01');
  assert.deepEqual([details.response, details.detail], ['yes', 'Ticket, manager approval, then IT']);
});

test('answer fields: an unknown key, fields on a question without them, a bad date or number are refused', () => {
  assert.throws(() => parse({ f: { 'GOV-01': { nope: 'x' } } }, ['GOV-01']), /does not belong/);
  assert.throws(() => parse({ f: { 'FTP-01': { list: 'x' } } }, ['FTP-01']), /does not belong/);
  assert.throws(() => parse({ r: { 'GOV-02': 'yes' }, y: { 'GOV-02': 'x' } }, ['GOV-02']), /does not belong/);
  assert.throws(() => parse({ f: { 'GOV-01': { last_review_date: '2026-02-31' } } }, ['GOV-01']), /Date of last review: give a real date/);
  assert.throws(() => parse({ r: { 'END-01': 'yes' }, f: { 'END-01': { product: 'X', coverage: 'most' } } }, ['END-01']), /give a number/);
});

test('answer fields: submission asks for every field; a reassessment copies fields and a Yes, not an earlier bank\'s text', () => {
  const q = { sections: [{ ids: ['GOV-01', 'IAM-01'] }] };
  const problems = answers => vendorAnswers.submissionProblems(q, BANK, new Map(Object.entries(answers)), new Map(), [])
    .filter(p => p.kind === 'fields').map(p => p.id);
  assert.deepEqual(problems({
    'GOV-01': { response: 'text', detail: 'x', fields: { review_frequency: 'Yearly' } },
    'IAM-01': { response: 'yes', detail: null },
  }), ['GOV-01', 'IAM-01']);
  assert.deepEqual(problems({
    'GOV-01': { response: 'text', detail: 'x', fields: { review_frequency: 'Yearly', approver: 'Board', current_version: '4', last_review_date: '2026-03-01' } },
    'IAM-01': { response: 'yes', detail: 'Ticket and approval' },
  }), []);
  const gov = RULES.get('GOV-01');
  assert.equal(vendorAnswers.normalisedCopy(gov, { response: 'text', detail: 'Yearly, by the board', fields: null }), null,
    'a version 4 written answer does not fit the fields');
  const copied = vendorAnswers.normalisedCopy(gov, { response: 'text', detail: 'old', fields: { approver: 'Board', gone: 'x' }, evidence_ref: null, evidence_date: null });
  assert.deepEqual([copied.fields, copied.detail], [{ approver: 'Board' }, 'Who approves the policy: Board']);
  const iam = vendorAnswers.normalisedCopy(RULES.get('IAM-01'), { response: 'yes', detail: null, evidence_ref: 'Access policy', evidence_date: null });
  assert.deepEqual([iam.response, iam.detail, iam.fields, iam.evidence_ref], ['yes', null, null, 'Access policy']);
  const gov2 = vendorAnswers.normalisedCopy(RULES.get('GOV-02'), { response: 'yes', detail: null, fields: null, evidence_ref: null, evidence_date: null });
  assert.deepEqual([gov2.response, gov2.detail, gov2.fields], ['yes', null, null]);
  const kept = vendorAnswers.normalisedCopy(RULES.get('GOV-02'), { response: 'yes', detail: 'x', fields: { name: 'A. Rao', gone: 'x' }, evidence_ref: null, evidence_date: null });
  assert.deepEqual([kept.fields, kept.detail], [{ name: 'A. Rao' }, 'Name: A. Rao']);
  const qy = { sections: [{ ids: ['GOV-02', 'IAM-01'] }] };
  assert.deepEqual(vendorAnswers.submissionProblems(qy, BANK, new Map([['GOV-02', gov2], ['IAM-01', iam]]), new Map(), [])
    .filter(p => p.kind === 'fields').map(p => p.id), ['GOV-02', 'IAM-01'], 'the empty boxes are asked for at submission');
  const v4 = vendorAnswers.rulesMap(V4).get('GOV-01');
  assert.deepEqual([v4.fields, v4.fieldsOn], [[], null]);
});
