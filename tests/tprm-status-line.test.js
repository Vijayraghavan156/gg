'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { statusLine } = require('../lib/tprm/status-line');

const base = '/tprm/clients/1/third-parties/2/assessments/3';
const day = d => ({ '2026-11-20': '20 Nov 2026', '2026-11-21': '21 Nov 2026', '2026-12-22': '22 Dec 2026' })[d] || String(d);
const tierLabel = k => ({ high: 'High', medium: 'Medium' })[k];
const consultant = { canManage: true, canReview: false, isManager: false, isProposer: false, selfApproveTiers: false };
const senior = { canManage: true, canReview: true, isManager: false, isProposer: false, selfApproveTiers: false };
const line = (a, extra = {}) => statusLine({ assessment: { final_tier: 'high', ...a }, thirdParty: { name: 'CloudVault' }, base, day, tierLabel, viewer: consultant, ...extra });

test('scope: in progress, sent back (who and why), the consultant continues', () => {
  let l = line({ status: 'scoping' });
  assert.deepEqual([l.key, l.text, l.action.label, l.action.href], ['scoping', 'Answer the criticality questions and propose a tier.', 'Continue the scope', `${base}?step=scope`]);
  assert.equal(l.action.step, 'scope', 'the page leaves the action out on its own step');
  l = line({ status: 'scoping', return_comment: 'Services missing.\nAdd the backup service.', returned_by_name: 'Priya', returned_at: '2026-11-21' });
  assert.equal(l.text, 'Sent back by Priya on 21 Nov 2026: Services missing.');
  assert.equal(l.tone, 'attention');
  assert.equal(line({ status: 'scoping' }, { viewer: { ...consultant, canManage: false } }).action, null, 'no action for a user who cannot change it');
});

test('a proposed tier waits for a second person; only a reviewer who is not the proposer gets "Confirm the tier"', () => {
  const a = { status: 'tier_proposed', proposed_by_name: 'Kabir' };
  assert.equal(line(a).text, 'Tier High proposed by Kabir, waiting for a second person to confirm it.');
  assert.equal(line(a).action, null, 'a consultant cannot confirm');
  assert.equal(line(a, { viewer: senior }).action.label, 'Confirm the tier');
  assert.equal(line(a, { viewer: { ...senior, isProposer: true } }).action, null, 'not the proposer');
  assert.equal(line(a, { viewer: { ...senior, isProposer: true, isManager: true, selfApproveTiers: true } }).action.label, 'Confirm the tier', 'a manager where the firm allows self-approval');
});

test('the questionnaire: prepare, send, with the third party (named, progress, the link\'s end), no link', () => {
  const a = { status: 'tier_confirmed' };
  assert.equal(line(a, { qp: { questionnaire: null, canPrepare: true } }).action.label, 'Prepare the questionnaire');
  assert.equal(line(a, { qp: { questionnaire: null, canPrepare: false } }).action, null);
  assert.equal(line(a, { qp: { questionnaire: { status: 'draft' } } }).action.label, 'Send it to the third party');
  const qp = { questionnaire: { status: 'in_progress', sent_at: '2026-11-20' }, activeLink: { recipient_name: 'Dana Okafor', expires_at: '2026-12-22' }, review: { answered: 28, total: 66 } };
  const l = line(a, { qp });
  assert.equal(l.text, 'Waiting on Dana Okafor at CloudVault since 20 Nov 2026. 28 of 66 questions answered. The link stops working on 22 Dec 2026.');
  assert.deepEqual([l.tone, l.action], ['attention', null]);
  const none = line(a, { qp: { ...qp, activeLink: null } });
  assert.match(none.text, /No link is active\.$/);
  assert.equal(none.action.label, 'Issue a new link');
});

test('the review of answers: what is left, clarifications waited on, then close', () => {
  const a = { status: 'tier_confirmed' };
  const qp = r => ({ questionnaire: { status: 'under_review' }, review: r });
  let l = line(a, { qp: qp({ blockers: { unreviewed: 24, unclosed: 1, unchecked: 0 }, openClarifications: 1 }) });
  assert.equal(l.text, '24 answers without a conclusion. Waiting on CloudVault for 1 clarification.');
  assert.deepEqual([l.action.label, l.action.href], ['Review the answers', `${base}?step=review#questionnaire-answers`]);
  l = line(a, { qp: qp({ blockers: { unreviewed: 0, unclosed: 0, unchecked: 1 }, openClarifications: 0 }) });
  assert.equal(l.text, '1 certificate or report to check.');
  l = line(a, { qp: qp({ blockers: { unreviewed: 0, unclosed: 0, unchecked: 0 }, openClarifications: 0 }) });
  assert.deepEqual([l.text, l.action.label], ['Every answer has a conclusion. The review can be closed.', 'Close the review']);
  l = line(a, { qp: qp({ blockers: { unreviewed: 0, unclosed: 1, unchecked: 0 }, openClarifications: 1 }) });
  assert.deepEqual([l.text, l.action], ['Every answer has a conclusion. Waiting on CloudVault for 1 clarification.', null]);
});

test('the recommendation: next, drafted, changes requested, in review (the reviewer gets the action), issued, the client', () => {
  const closed = { questionnaire: { status: 'closed' } };
  assert.equal(line({ status: 'tier_confirmed' }, { qp: closed, rd: { canCreate: true } }).action.label, 'Draft the recommendation');
  assert.equal(line({ status: 'tier_confirmed' }, { qp: closed, rd: { canCreate: false } }).action, null);
  assert.equal(line({ status: 'recommendation_draft' }, { rd: { open: { status: 'draft', version: 2, author_name: 'Kabir' }, canEdit: true } }).text,
    'Recommendation version 2 is being drafted by Kabir.');
  const changes = line({ status: 'recommendation_draft' }, { rd: { open: { status: 'changes_requested', version: 2, reviewer_name: 'Priya', review_comment: 'Rating too low for an open High finding.' }, canEdit: true } });
  assert.deepEqual([changes.text, changes.action.label], ['Changes requested on recommendation version 2 by Priya: Rating too low for an open High finding.', 'Change the recommendation']);
  const inReview = { status: 'recommendation_in_review' };
  const rd = c => ({ open: { status: 'in_review', version: 2, submitted_at: '2026-11-21' }, canReviewOpen: c });
  assert.equal(line(inReview, { rd: rd(false) }).text, 'Recommendation version 2 is waiting for a second person to review it since 21 Nov 2026.');
  assert.equal(line(inReview, { rd: rd(false) }).action, null);
  assert.equal(line(inReview, { rd: rd(true), viewer: senior }).action.label, 'Review the recommendation');
  const issued = line({ status: 'recommendation_issued', client_decision_owner_name: 'Anita Rao' }, { rd: { issued: { issued_at: '2026-11-21' } } });
  assert.deepEqual([issued.text, issued.action], ['Recommendation issued on 21 Nov 2026. Waiting on Anita Rao to record the client\'s decision.', null]);
  assert.match(line({ status: 'recommendation_issued' }, { rd: { issued: {} } }).text, /Waiting on the client decision owner/);
});

test('more information, completed and cancelled', () => {
  const info = line({ status: 'information_requested' }, { dp: { informationRequest: { decided_by_name: 'Anita Rao', decided_at: '2026-11-21', rationale: 'Send the DR test.' }, canStartRevision: true } });
  assert.deepEqual([info.text, info.action.label, info.action.href], ['Anita Rao asked for more information on 21 Nov 2026: Send the DR test.', 'Start a revised recommendation', `${base}?step=decision`]);
  const done = line({ status: 'completed' }, { dp: { decisions: [{ outcome: 'approve', decided_at: '2026-11-21' }], labels: { approve: 'Approved' } } });
  assert.deepEqual([done.text, done.tone, done.action], ['Completed on 21 Nov 2026: Approved.', 'good', null]);
  assert.equal(line({ status: 'cancelled', cancelled_at: '2026-11-20', cancel_reason: 'Superseded' }).text, 'Cancelled on 20 Nov 2026: Superseded');
});

test('every line is one plain sentence or two: no raw keys, no "undefined", no dashes', () => {
  const samples = [
    line({ status: 'scoping' }), line({ status: 'tier_proposed' }), line({ status: 'tier_confirmed' }, { qp: { questionnaire: null } }),
    line({ status: 'recommendation_in_review' }, { rd: {} }), line({ status: 'recommendation_issued' }, { rd: {} }),
    line({ status: 'information_requested' }, { dp: {} }), line({ status: 'completed' }, { dp: {} }), line({ status: 'cancelled' }),
  ];
  for (const l of samples) {
    assert.doesNotMatch(l.text, /undefined|null|_|[–—]/, l.text);
    assert.match(l.text, /^[A-Z0-9].*\.$|: /, l.text);
  }
});
