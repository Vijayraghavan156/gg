'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('../lib/tprm/history');

const MODULES = ['questionnaires', 'vendor-answers', 'assurance-reports', 'evidence', 'findings', 'recommendations', 'decisions', 'conditions',
  'ai-review', 'contract-review', 'exit-plans'];
const ASSESSMENT_ACTIONS = ['assessment.started', 'assessment.scope_saved', 'assessment.tier_proposed', 'assessment.tier_returned',
  'assessment.tier_confirmed', 'assessment.cancelled', 'assessment.details_updated', 'recommendation.report_generated'];

function allActions() {
  const actions = new Set(ASSESSMENT_ACTIONS);
  for (const m of MODULES) {
    const mod = require(`../lib/tprm/${m}`);
    for (const key of ['EVENT_LABELS', 'ACTION_LABELS']) for (const a of Object.keys(mod[key] || {})) actions.add(a);
  }
  return [...actions];
}

const at = (n) => new Date(Date.UTC(2026, 10, 22, 10, 0, 60 - n)).toISOString();
const ev = (action, after = {}, extra = {}) => ({ id: Math.floor(Math.random() * 1e9), action, after_state: after, before_state: {}, created_at: at(1), actor_name: 'Kabir', ...extra });

test('every action a TPRM module records on an assessment has a sentence', () => {
  const missing = allActions().filter(a => !history.SENTENCES[a]);
  assert.deepEqual(missing, []);
});

test('each sentence is plain: no undefined, no null, no raw keys, no dashes, starts with a capital', () => {
  const typical = { version: 2, question_id: 'GOV-02', conclusion: 'partially_satisfactory', title: 'No pen test', severity: 'high', name: 'policy.pdf',
    module: 'AI Services', recipient_name: 'Dana', reason: 'Superseded', kind: 'soc2_type2', count: 3, final_tier: 'high', outcome: 'approve', outcome_label: 'Approved',
    scope: 'all sections', accepted_with: 3, condition_number: 2, vendor_question_count: 66, by: undefined };
  for (const action of allActions()) {
    for (const after of [{}, typical]) {
      const list = history.entries([ev(action, after)], { tierLabel: t => ({ high: 'High' })[t], conclusionLabels: { partially_satisfactory: 'Partially satisfactory' } }).list;
      const text = list[0].text;
      assert.doesNotMatch(text, /undefined|null|NaN|\[object|[–—]|\s{2}|\s$|""/, `${action}: ${text}`);
      assert.doesNotMatch(text, new RegExp(action.replace('.', '\\.')), `${action}: no raw key`);
      assert.match(text, /^[A-Z0-9"]/, `${action}: ${text}`);
    }
  }
});

test('runs fold into one line; a bulk accept is one sentence; search covers everything', () => {
  const events = [];
  for (let i = 0; i < 34; i++) events.push({ ...ev('answer.accepted_in_bulk', { question_id: `Q-${i}`, conclusion: 'satisfactory', accepted_with: 34, scope: 'all sections' }), created_at: at(i) });
  events.push(ev('answer.reviewed', { question_id: 'GOV-02', conclusion: 'unsatisfactory', comment: 'No owner named' }));
  for (let i = 0; i < 6; i++) events.push({ ...ev('questionnaire.answers_saved', { by: 'third_party', count: 4 }), actor_name: null, created_at: at(40 + i) });
  const out = history.entries(events, { conclusionLabels: { unsatisfactory: 'Unsatisfactory' } });
  assert.equal(out.total, 3);
  assert.deepEqual(out.list.map(e => e.text), [
    'Kabir accepted 34 plain answers as Satisfactory (all sections)',
    'Kabir marked GOV-02 unsatisfactory: No owner named',
    'The third party saved answers (6 times)',
  ]);
  assert.equal(out.list[2].thirdParty, true);
  const found = history.entries(events, { q: 'gov-02' });
  assert.deepEqual([found.matched, found.list[0].action], [1, 'answer.reviewed']);
  assert.equal(history.entries(events, { q: 'nothing like this' }).matched, 0);
  const many = [];
  for (let i = 0; i < 260; i++) many.push({ ...ev('clarification.asked', { question_id: `Q-${i}` }), created_at: at(i) });
  const page = history.entries(many);
  assert.deepEqual([page.total, page.shown, page.list.length], [260, 200, 200]);
  assert.equal(history.entries(many, { q: 'q-259' }).list[0].text, 'Kabir asked a clarification on Q-259');
});

test('self-approval, self-issue and the client decision keep their own words', () => {
  const out = history.entries([
    ev('assessment.tier_confirmed', { final_tier: 'high', self_approved: true, self_approval_reason: 'Small engagement' }),
    ev('recommendation.issued', { version: 1, self_issued: true, self_issue_reason: 'Only consultant' }),
    ev('client_decision.recorded', { outcome: 'approve', outcome_label: 'Approved', version: 1 }, { actor_name: 'Anita Rao' }),
  ], { tierLabel: t => ({ high: 'High' })[t] });
  assert.deepEqual(out.list.map(e => [e.text, e.extra]), [
    ['Kabir confirmed tier High', { selfApproved: 'Self-approved by Kabir: Small engagement' }],
    ['Kabir issued recommendation version 1', { selfIssued: 'Self-issued by Kabir: Only consultant' }],
    ['Anita Rao recorded the client\'s decision: Approved (version 1)', { decision: 'Approved (version 1)' }],
  ]);
});
