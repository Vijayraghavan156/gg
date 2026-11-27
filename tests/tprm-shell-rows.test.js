'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shell = require('../lib/tprm/shell');

const client = { id: 7, name: 'Harbourline', ws: { id: 7, firm_timezone: 'Asia/Kolkata' } };
const empty = { parties: [], assessments: [], questionnaires: [], conditions: [], requests: [] };

test('questionnaire, condition and review dates become calendar items in the client time zone', () => {
  const rows = {
    ...empty,
    questionnaires: [{ id: 1, workspace_id: 7, assessment_id: 11, third_party_id: 21, lead_consultant_id: 5,
      third_party_name: 'Orbit Shred', expires_at: '2026-12-16T20:00:00Z', link_status: 'active' }],
    conditions: [
      { id: 2, workspace_id: 7, position: 2, status: 'open', due_date: '2027-01-31', waive_until: null, assessment_id: 12, third_party_id: 22, lead_consultant_id: 5, third_party_name: 'Lumen' },
      { id: 3, workspace_id: 7, position: 3, status: 'waived', due_date: '2027-02-28', waive_until: '2099-01-01', assessment_id: 12, third_party_id: 22, lead_consultant_id: 5, third_party_name: 'Lumen' },
    ],
    parties: [
      { third_party_id: 23, workspace_id: 7, name: 'PayNimbus', status: 'in_use', next_due_date: '2099-03-01', team_owner_id: 6, assessing: false },
      { third_party_id: 24, workspace_id: 7, name: 'Busy Co', status: 'in_use', next_due_date: '2020-01-01', team_owner_id: 6, assessing: true },
    ],
  };
  const items = shell.calendarFromRows(rows, [client]);
  const byKind = k => items.filter(i => i.kind === k);
  const q = byKind('tp-questionnaire');
  assert.equal(q.length, 1);
  assert.equal(q[0].date, '2026-12-17', 'the link end is a date in the client time zone');
  assert.equal(q[0].link, '/tprm/clients/7/third-parties/21/assessments/11?step=questionnaire');
  assert.equal(q[0].wsName, 'Harbourline');
  const c = byKind('tp-condition');
  assert.deepEqual(c.map(i => [i.title, i.date]), [['Condition 2 due: Lumen', '2027-01-31']], 'a waived condition is met and left out');
  const r = byKind('tp-review');
  assert.deepEqual(r.map(i => i.title), ['Review due: PayNimbus'], 'a supplier under assessment has no separate review date');
  assert.equal(r[0].countsWorkload, false, 'a review years away is not open work yet');
  assert.equal(r[0].ownerId, 6);
});

test('status counts leave out suppliers under assessment and met conditions', () => {
  const rows = {
    ...empty,
    parties: [
      { third_party_id: 1, workspace_id: 7, name: 'Lapsed', status: 'in_use', next_due_date: '2020-01-01', assessing: false },
      { third_party_id: 2, workspace_id: 7, name: 'Busy', status: 'in_use', next_due_date: '2020-01-01', assessing: true },
    ],
    conditions: [
      { id: 1, workspace_id: 7, position: 1, status: 'open', due_date: '2026-01-01', waive_until: null, third_party_id: 1 },
      { id: 2, workspace_id: 7, position: 2, status: 'proof_submitted', due_date: '2099-01-01', waive_until: null, third_party_id: 1 },
    ],
  };
  const s = shell.statusOf(rows, 7, '2026-11-27');
  assert.equal(s.parties, 2);
  assert.equal(s.reassessmentsOverdue, 1);
  assert.equal(s.conditionsOverdue, 1);
  assert.equal(s.proofsToCheck, 1);
  assert.equal(s.severity, 'high');
  assert.deepEqual(s.reasons, ['1 review overdue', '1 condition overdue', '1 condition proof to check']);
});
