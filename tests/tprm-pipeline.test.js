'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stageOf, parseFilters, WAITING_LABELS } = require('../lib/tprm/pipeline');

test('each open state has a step and someone it waits on, named where the records hold a name', () => {
  const cases = [
    [{ status: 'scoping', lead_name: 'Kabir' }, ['Scope and tier', 'consultant', 'Kabir']],
    [{ status: 'tier_proposed' }, ['Tier to confirm', 'reviewer', null]],
    [{ status: 'tier_confirmed', q_status: null, lead_name: 'Kabir' }, ['Questionnaire to send', 'consultant', 'Kabir']],
    [{ status: 'tier_confirmed', q_status: 'in_progress', recipient_name: 'Dana Okafor' }, ['Questionnaire with the third party', 'third_party', 'Dana Okafor']],
    [{ status: 'tier_confirmed', q_status: 'under_review', unreviewed: 4 }, ['Review of answers', 'consultant', null]],
    [{ status: 'tier_confirmed', q_status: 'under_review', unreviewed: 0, open_clarifications: 1 }, ['Clarifications with the third party', 'third_party', null]],
    [{ status: 'tier_confirmed', q_status: 'under_review', unreviewed: 0, open_clarifications: 0 }, ['Review to close', 'consultant', null]],
    [{ status: 'tier_confirmed', q_status: 'closed', author_name: 'Riya' }, ['Recommendation to draft', 'consultant', 'Riya']],
    [{ status: 'recommendation_draft', rec_status: 'changes_requested', author_name: 'Kabir' }, ['Recommendation: changes requested', 'consultant', 'Kabir']],
    [{ status: 'recommendation_in_review' }, ['Recommendation to review', 'reviewer', null]],
    [{ status: 'recommendation_issued', owner_name: 'Anita Rao' }, ['Client decision', 'client', 'Anita Rao']],
    [{ status: 'information_requested', lead_name: 'Kabir' }, ['Client asked for more information', 'consultant', 'Kabir']],
  ];
  for (const [row, [step, waiting, name]] of cases) {
    const s = stageOf(row);
    assert.deepEqual([s.step, s.waiting, s.waitingName || null], [step, waiting, name], row.status);
    assert.ok(WAITING_LABELS[s.waiting], `${row.status}: a label for who it waits on`);
  }
});

test('filters come from the address and fall back to everything', () => {
  assert.deepEqual(parseFilters({}), { who: 'all', waiting: '', late: false, due30: false, sort: 'due', dir: 'asc', q: '' });
  assert.deepEqual(parseFilters({ who: 'me', waiting: 'third_party', late: '1', due: '30', sort: 'days', dir: 'desc', q: ' cloud ' }),
    { who: 'me', waiting: 'third_party', late: true, due30: true, sort: 'days', dir: 'desc', q: 'cloud' });
  assert.deepEqual(parseFilters({ who: 'x', waiting: 'nobody', sort: 'drop table', dir: 'sideways' }), parseFilters({}));
});
