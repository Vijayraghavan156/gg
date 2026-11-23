'use strict';

const format = require('./format');

const TONES = Object.freeze(['quiet', 'attention', 'problem', 'good']);

const APPROVAL = Object.freeze({
  approved: 'Approved',
  approved_with_conditions: 'Approved with conditions',
  expired: 'Approval expired',
  not_approved: 'Not approved',
  exited: 'Exited',
  not_yet_assessed: 'Not assessed yet',
  awaiting_approval: 'Not assessed yet',
});
const APPROVAL_TONE = Object.freeze({
  approved: 'quiet', approved_with_conditions: 'quiet', expired: 'attention', not_approved: 'quiet',
  exited: 'quiet', not_yet_assessed: 'quiet', awaiting_approval: 'quiet',
});

const PENDING = Object.freeze({
  in_progress: 'Assessment in progress',
  decision_needed: 'Waiting for your decision',
  information_requested: 'More information requested',
});
const PENDING_FIRM = Object.freeze({ ...PENDING, decision_needed: 'Waiting for the client\'s decision' });
const PENDING_TONE = Object.freeze({ in_progress: 'quiet', decision_needed: 'attention', information_requested: 'attention' });

const TIER_NEEDED = 'Tier needed';

function approval(state, until = null) {
  if (state === 'approved') return until ? `Approved until ${format.day(until)}` : APPROVAL.approved;
  if (state === 'expired') return until ? `Approval expired on ${format.day(until)}` : APPROVAL.expired;
  return APPROVAL[state] || '';
}
const approvalTone = state => APPROVAL_TONE[state] || 'quiet';

function pending(key, audience = 'client') {
  return (audience === 'firm' ? PENDING_FIRM : PENDING)[key] || '';
}
const pendingTone = key => PENDING_TONE[key] || 'quiet';

function due({ nextDueDate = null, lastAssessmentDate = null, inProgress = false, today }) {
  if (inProgress) return { key: 'in_progress', label: lastAssessmentDate ? 'Reassessment in progress' : 'Assessment in progress', tone: 'quiet' };
  if (!lastAssessmentDate && (!nextDueDate || nextDueDate === today)) return { key: 'not_assessed', label: APPROVAL.not_yet_assessed, tone: 'quiet' };
  if (!nextDueDate) return { key: 'none', label: '', tone: 'quiet' };
  if (nextDueDate < today) return { key: 'overdue', label: `Due ${format.day(nextDueDate)}, ${format.relative(nextDueDate, today)}`, tone: 'problem' };
  if (nextDueDate === today) return { key: 'due_today', label: 'Due today', tone: 'attention' };
  const rel = format.relative(nextDueDate, today);
  const days = Math.round((Date.parse(`${nextDueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return { key: 'due', label: days <= 30 ? `Due ${format.day(nextDueDate)}, ${rel}` : `Due ${format.day(nextDueDate)}`, tone: 'quiet' };
}

module.exports = { TONES, APPROVAL, PENDING, PENDING_FIRM, TIER_NEEDED, approval, approvalTone, pending, pendingTone, due };
