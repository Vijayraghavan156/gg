'use strict';

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const firstLine = v => String(v == null ? '' : v).split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
const clip = (v, max = 160) => { const t = firstLine(v); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}...` : t; };
const said = v => (firstLine(v) ? `: ${clip(v)}` : '');
const human = v => String(v || '').replace(/_/g, ' ');
const rec = a => (a.version ? `recommendation version ${a.version}` : 'the recommendation');
const cond = a => (a.position || a.condition_number ? `condition ${a.position || a.condition_number}` : 'a condition');
const outcome = a => (a.outcome_label || a.outcome ? `: ${a.outcome_label || human(a.outcome)}` : '');

const msgRole = a => (a.to === 'third_party' ? 'the third party' : a.to === 'client' ? 'the client' : 'the consultant') + (a.recipient_name ? ` (${a.recipient_name})` : '');
const msgKind = a => require('./messages').KIND_LABELS[a.kind] || human(a.kind);

const P = (verb) => ({ who: 'person', verb });
const T = (verb) => ({ who: 'third_party', verb });
const N = (verb) => ({ who: 'none', verb });

const SENTENCES = Object.freeze({
  'assessment.started': P(a => `started the ${a.type === 'reassessment' ? 'reassessment' : 'assessment'}`),
  'assessment.scope_saved': P(() => 'saved the scope and answers'),
  'assessment.tier_proposed': P((a, b, o) => `proposed ${a.final_tier ? `tier ${o.tier(a.final_tier)}` : 'a tier'}`),
  'assessment.tier_returned': P(a => `sent the scope back${said(a.comment || a.return_comment)}`),
  'assessment.tier_confirmed': P((a, b, o) => `confirmed ${a.final_tier ? `tier ${o.tier(a.final_tier)}` : 'the tier'}`),
  'assessment.cancelled': P(a => `cancelled the assessment${said(a.reason || a.cancel_reason)}`),
  'assessment.details_updated': P(() => 'updated the assessment details'),
  'questionnaire.prepared': P(a => `prepared the questionnaire${a.vendor_question_count ? ` (${plural(a.vendor_question_count, 'question')})` : ''}`),
  'questionnaire.module_added': P(a => `added ${a.module ? `the ${a.module} module` : 'a module'} to the questionnaire`),
  'questionnaire.module_removed': P(a => `removed ${a.module ? `the ${a.module} module` : 'a module'} from the questionnaire`),
  'questionnaire.module_kept': N(a => `${a.module || 'AI Services'} stayed in the questionnaire after AIS-01 changed to No`),
  'questionnaire.sent': P(() => 'sent the questionnaire'),
  'questionnaire.closed': P(a => `closed the questionnaire${said(a.reason)}`),
  'questionnaire.not_returned': P(a => `closed the questionnaire as not returned${said(a.reason)}`),
  'vendor_link.created': P(a => `created a link for ${a.recipient_name || 'the third party'}`),
  'vendor_link.emailed': P(a => `emailed the link${a.recipient_name ? ` to ${a.recipient_name}` : ' to the third party'}`),
  'vendor_link.revoked': P(a => `revoked the link${said(a.reason)}`),
  'vendor_link.used': N(() => 'The submission used up the link'),
  'message.sent': N(a => `Email sent to ${msgRole(a)}: ${msgKind(a)}`),
  'message.failed': N(a => `Email to ${msgRole(a)} not sent: ${msgKind(a)}`),
  'questionnaire.answering_started': T(() => 'started answering'),
  'questionnaire.answers_saved': T(a => `saved ${a.count ? plural(a.count, 'answer') : 'answers'}`),
  'questionnaire.prefilled': N(a => `${plural(a.count || 0, 'answer')} filled in from the last questionnaire${a.not_copied ? ` (${a.not_copied} asked again)` : ''}`),
  'questionnaire.submitted': T(a => `submitted the questionnaire${a.vendor_question_count ? ` (${plural(a.vendor_question_count, 'question')})` : ''}`),
  'clarification.answered': T(a => `answered the clarification on ${a.question_id || 'a question'}`),
  'assurance_report.uploaded': T(a => `added ${a.kind === 'soc2_type2' ? 'a SOC 2 Type II report' : a.kind === 'iso27001' ? 'an ISO 27001 certificate' : 'an assurance report'}`),
  'assurance_report.updated': T(() => 'changed an assurance report'),
  'assurance_report.removed': T(() => 'removed an assurance report'),
  'evidence.described': T(a => `described ${a.name ? `"${a.name}"` : 'a document'}`),
  'questionnaire.review_started': P(() => 'started reviewing the answers'),
  'questionnaire.reviewed': P(a => `closed the review of the answers${a.conclusions ? ` (${Object.entries(a.conclusions).filter(([k]) => k !== 'not_reviewed').map(([k, n]) => `${n} ${human(k)}`).join(', ')})` : ''}`),
  'answer.reviewed': P((a, b, o) => `${a.conclusion ? `marked ${a.question_id || 'an answer'} ${o.conclusion(a.conclusion).toLowerCase()}` : `reviewed ${a.question_id || 'an answer'}`}${a.comment ? `: ${clip(a.comment, 120)}` : ''}`),
  'answer.accepted_in_bulk': P((a, b, o) => `accepted ${plural(o.count, 'plain answer')} as Satisfactory${a.scope ? ` (${a.scope})` : ''}`),
  'clarification.asked': P(a => `asked a clarification on ${a.question_id || 'a question'}${said(a.body)}`),
  'clarification.closed': P(a => `closed the clarification on ${a.question_id || 'a question'}${said(a.note)}`),
  'assurance_report.accepted': P(a => `accepted the ${a.kind === 'soc2_type2' ? 'SOC 2 Type II report' : 'ISO 27001 certificate'}${said(a.reason)}`),
  'assurance_report.rejected': P(a => `rejected the ${a.kind === 'soc2_type2' ? 'SOC 2 Type II report' : 'ISO 27001 certificate'}${said(a.reason)}`),
  'evidence_waiver.added': P(a => `waived the evidence on ${a.question_id || 'a question'} (SOC 2)`),
  'evidence_waiver.withdrawn': P(a => `withdrew the evidence waiver on ${a.question_id || 'a question'}`),
  'evidence.uploaded': P(a => `uploaded ${a.name ? `"${a.name}"` : 'a file'}`),
  'evidence.released': P(a => `released ${a.name ? `"${a.name}"` : 'a file'} to the client`),
  'evidence.deleted': P(a => `deleted ${a.name ? `"${a.name}"` : 'a file'}`),
  'finding.added': P(a => `added ${a.title ? `the finding "${clip(a.title, 120)}"` : 'a finding'}${a.severity ? ` (${human(a.severity).charAt(0).toUpperCase()}${human(a.severity).slice(1)})` : ''}`),
  'finding.updated': P((a, b) => { const t = a.title || (b && b.title); return `updated ${t ? `the finding "${clip(t, 120)}"` : 'a finding'}`; }),
  'finding.removed': P((a, b) => { const t = (b && b.title) || a.title; return `removed ${t ? `the finding "${clip(t, 120)}"` : 'a finding'}`; }),
  'ai_review.queued': P(() => 'asked for an AI review'),
  'ai_review.not_configured': N(() => 'The AI review is not set up for this firm: nothing was sent'),
  'ai_review.succeeded': N(a => `The AI review finished${a.suggestions != null ? ` with ${plural(a.suggestions, 'suggestion')}` : ''}`),
  'ai_review.failed': N(a => `The AI review failed${said(a.error)}`),
  'ai_review.limit_reached': N(() => 'The automatic AI review was skipped: 3 runs in 24 hours'),
  'ai_suggestion.accepted': P(a => (a.kind === 'conclusion' ? 'accepted the AI review\'s suggested conclusion' : 'accepted an AI suggestion as a finding')),
  'ai_suggestion.edited_accepted': P(() => 'edited an AI suggestion and accepted it as a finding'),
  'ai_suggestion.rejected': P(a => `rejected an AI suggestion${said(a.reason)}`),
  'contract_review.started': P(() => 'started the contract checklist'),
  'contract_review.updated': P(a => `updated the contract checklist${a.clause_id ? ` (${a.clause_id})` : ''}`),
  'contract_review.finding_raised': P(a => `raised a finding from the contract checklist${a.clause_id ? ` (${a.clause_id})` : ''}`),
  'contract_review.clauses_added': P(a => `added rulebook clauses to the contract checklist${Array.isArray(a.clause_ids) ? ` (${a.clause_ids.length})` : ''}`),
  'recommendation.drafted': P(a => `started ${rec(a)}`),
  'recommendation.saved': P(a => `saved the draft of ${rec(a)}`),
  'recommendation.submitted': P(a => `sent ${rec(a)} for review`),
  'recommendation.changes_requested': P(a => `asked for changes to ${rec(a)}${said(a.comment)}`),
  'recommendation.issued': P(a => `issued ${rec(a)}`),
  'recommendation.superseded': N(a => `${rec(a).charAt(0).toUpperCase()}${rec(a).slice(1)} was superseded`),
  'recommendation.withdrawn': P(a => `withdrew ${rec(a)}${said(a.reason)}`),
  'recommendation.new_version_started': P(a => `started ${rec(a)}${said(a.reason)}`),
  'recommendation.recalled': P(a => `recalled ${rec(a)} to draft`),
  'recommendation.reassigned': P(a => `handed the recommendation to ${a.author_name || 'another consultant'}`),
  'recommendation.report_generated': P(a => `downloaded the report of ${rec(a)}`),
  'recommendation.exit_plan_conditions_synced': N(() => 'The automatic exit plan conditions were updated'),
  'recommendation.auto_condition_removed': P(() => 'removed an automatic condition'),
  'recommendation.override_outcome_changed': P(a => `changed the outcome after an override${said(a.reason)}`),
  'service.material_changed': P(a => `marked the service ${a.material ? 'material' : 'not material'}`),
  'exit_plan.saved': P(() => 'saved the exit plan'),
  'client_decision.recorded': P(a => `recorded the client's decision${outcome(a)}${a.version ? ` (version ${a.version})` : ''}`),
  'third_party.client_decision': P(a => `recorded the client's decision${outcome(a)}`),
  'condition.proof_submitted': T(a => `submitted proof for ${cond(a)}`),
  'condition.verified': P(a => `verified ${cond(a)}`),
  'condition.changes_requested': P(a => `asked for changes to the proof of ${cond(a)}${said(a.reason || a.comment)}`),
  'condition.waived': P(a => `waived ${cond(a)}${said(a.reason)}`),
  'third_party.conditions_met': N(() => 'Every condition is met'),
  'condition_link.created': P(a => `created a conditions link for ${a.recipient_name || 'the third party'}`),
  'condition_link.revoked': P(a => `revoked the conditions link${said(a.reason)}`),
});

const FOLD = new Set(['answer.accepted_in_bulk', 'questionnaire.answers_saved', 'recommendation.saved', 'contract_review.updated', 'evidence.uploaded']);

function subjectOf(e, spec) {
  const thirdParty = !!(e.after_state && e.after_state.by === 'third_party') || (spec && spec.who === 'third_party' && !e.actor_name);
  if (thirdParty) return { name: 'The third party', thirdParty: true };
  if (spec && spec.who === 'none') return { name: '', thirdParty: false };
  return { name: e.actor_name || 'Someone no longer in the firm', thirdParty: false };
}

function sentenceOf(e, o, count = 1) {
  const a = e.after_state || {};
  const spec = SENTENCES[e.action];
  const subj = subjectOf(e, spec);
  if (!spec) return { subj, text: `${subj.name ? `${subj.name}: ` : ''}${human(e.action)}` };
  let rest = spec.verb(a, e.before_state || {}, { ...o, count });
  if (count > 1 && e.action === 'evidence.uploaded') rest = `uploaded ${count} files`;
  else if (count > 1 && e.action !== 'answer.accepted_in_bulk') rest = `${rest.replace(/^saved \d+ answers?/, 'saved answers')} (${count} times)`;
  const text = spec.who === 'none' || !subj.name ? rest : `${subj.name} ${rest}`;
  const tidy = text.replace(/\s{2,}/g, ' ').trim();
  return { subj, text: tidy.charAt(0).toUpperCase() + tidy.slice(1) };
}

function entries(events, { tierLabel = t => t, conclusionLabels = {}, q = '', limit = 200 } = {}) {
  const o = { tier: t => (t ? tierLabel(t) : ''), conclusion: c => conclusionLabels[c] || human(c) };
  const sameDay = (x, y) => String(x).slice(0, 10) === String(y).slice(0, 10);
  const folded = [];
  for (const e of events) {
    const last = folded[folded.length - 1];
    const a = e.after_state || {};
    if (last && FOLD.has(e.action) && last.action === e.action && last.actor === (e.actor_name || '') && sameDay(new Date(last.at).toISOString(), new Date(e.created_at).toISOString())
      && (e.action !== 'answer.accepted_in_bulk' || (a.scope === last.scope && a.accepted_with === last.acceptedWith))) {
      last.count += 1;
      last.events.push(e);
      continue;
    }
    folded.push({ action: e.action, actor: e.actor_name || '', at: e.created_at, scope: a.scope, acceptedWith: a.accepted_with, count: 1, events: [e] });
  }
  const list = folded.map(f => {
    const e = f.events[0];
    const a = e.after_state || {};
    const { subj, text } = sentenceOf(e, o, f.count);
    const extra = {};
    if (e.action === 'assessment.tier_confirmed' && a.self_approved) extra.selfApproved = `Self-approved by ${e.actor_name || 'a manager'}: ${a.self_approval_reason || ''}`;
    if (e.action === 'recommendation.issued' && a.self_issued) extra.selfIssued = `Self-issued by ${e.actor_name || 'a manager'}: ${a.self_issue_reason || ''}`;
    if (e.action === 'client_decision.recorded' && a.outcome_label) extra.decision = `${a.outcome_label} (version ${a.version})`;
    if (e.action === 'questionnaire.module_added' && a.module) extra.module = a.module;
    return { id: Number(e.id), action: e.action, at: e.created_at, subject: subj.name, thirdParty: subj.thirdParty, text, extra, count: f.count };
  });
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = x => `${x.text} ${Object.values(x.extra).join(' ')}`.toLowerCase();
  const matched = words.length ? list.filter(x => words.every(w => haystack(x).includes(w))) : list;
  return { list: matched.slice(0, limit), total: list.length, matched: matched.length, shown: Math.min(limit, matched.length), searched: words.length > 0 };
}

module.exports = { SENTENCES, FOLD, entries, sentenceOf };
