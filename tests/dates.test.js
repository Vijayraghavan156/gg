'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { todayFor, workspaceTimeZone, shiftMonth } = require('../lib/dates');

test('workspace timezone overrides the firm default for calendar decisions', () => {
  const instant = new Date('2026-08-16T19:00:00.000Z');
  const firm = { timezone: 'America/Los_Angeles' };
  assert.equal(todayFor({ timezone: 'Asia/Kolkata' }, firm, instant), '2026-08-17');
  assert.equal(todayFor({}, firm, instant), '2026-08-16');
  assert.equal(workspaceTimeZone({}, firm), 'America/Los_Angeles');
});

test('invalid timezone values fall back to UTC and month shifts are calendar safe', () => {
  const instant = new Date('2026-08-16T23:30:00.000Z');
  assert.equal(todayFor({ timezone: 'not/a-zone' }, null, instant), '2026-08-16');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('third-party risk times are shown in the firm zone with the zone named, in one format', () => {
  const format = require('../lib/tprm/format');
  const f = format.forZone('Asia/Kolkata');
  assert.equal(f.dayTime('2026-11-26T17:47:00Z'), '26 Nov 2026, 11:17 pm IST');
  assert.equal(f.time('2026-11-26T17:47:00Z'), '11:17 pm IST');
  assert.equal(format.forZone('UTC').dayTime('2026-11-26T17:47:00Z'), '26 Nov 2026, 5:47 pm UTC');
  assert.equal(f.dayTime('2026-11-26T17:47:00Z', { zone: false }), '26 Nov 2026, 11:17 pm', 'a caller can still leave the zone out');
});
