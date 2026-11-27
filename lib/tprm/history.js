'use strict';

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const firstLine = v => String(v == null ? '' : v).split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
const clip = (v, max = 160) => { const t = firstLine(v); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}...` : t; };
const said = v => (firstLine(v) ? `: ${clip(v)}` : '');
const human = v => String(v || '').replace(/_/g, ' ');
const rec = a => (a.version ? `recommendation version ${a.version}` : 'the recommendation');
const cond = a => (a.position || a.condition_number ? `condition ${a.position || a.condition_number}` : 'a condition');
const outcome = a => (a.outcome_label || a.outcome ? `: ${a.outcome_label || human(a.outcome)}` : '');
const doc = a => (a && firstLine(a.title) ? `the document "${clip(a.title, 80)}"` : 'a document');

const dayOf = v => (v ? require('./format').day(String(v).slice(0, 10)) : '');
function detailsChanged(a, b) {
  const parts = [];
  if ('lead_consultant_id' in a) {
    const to = a.lead_consultant_name || null;
    const from = b.lead_consultant_name || null;
    if (!a.lead_consultant_id) parts.push('removed the lead');
    else if (!to) parts.push('changed the lead');
    else parts.push(from ? `changed the lead from ${from} to ${to}` : `set the lead to ${to}`);
  }
  if ('due_date' in a) parts.push(a.due_date ? `set the due date to ${dayOf(a.due_date)}` : 'removed the due date');
  if ('client_decision_owner_id' in a) {
    parts.push(a.client_decision_owner_id ? `named ${a.client_decision_owner_name || 'a new person'} as the client decision owner` : 'removed the client decision owner');
  }
  if (!parts.length) return 'updated the assessment details';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const PARTY_WORDS = Object.freeze({
  name: 'name', legal_name: 'legal name', registration_number: 'registration number', website: 'website', category: 'category', country: 'country',
  primary_contact_name: 'main contact name', primary_contact_email: 'main contact email', status: 'status', client_label: "client's criticality label",
  last_assessment_date: 'last assessment date', client_designated_critical: 'critical flag', current_tier: 'tier', tier_source: 'tier source',
  next_due_date: 'next review date', business_unit: 'business unit', service_volume: 'volume', client_owner_user_id: 'owner at the client',
  exit_date: 'exit date', exit_reason: 'exit reason',
});
const SERVICE_WORDS = Object.freeze({
  description: 'description', data_access: 'data access', hosting_countries: 'hosting countries', contract_start: 'contract start',
  contract_end: 'contract end', notice_period_days: 'notice period', annual_spend: 'annual spend', spend_currency: 'currency', sole_source: 'sole source',
});
const PLACEMENT_WORDS = Object.freeze({ current_tier: 'tier', next_due_date: 'next review date' });
function fieldList(a, words) {
  const names = [...new Set(Object.keys(a || {}).map(k => words[k]).filter(Boolean))];
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
function partyUpdated(a, b) {
  if (a.status === 'exited' && b.status !== 'exited') return `marked the third party as exited${said(a.exit_reason)}`;
  if (b.status === 'exited' && a.status && a.status !== 'exited') return 'reversed the exit of the third party';
  const fields = fieldList(a, PARTY_WORDS);
  return fields ? `changed the ${fields} of the third party` : 'updated the details of the third party';
}
const person = a => (firstLine(a.name) ? `${firstLine(a.name)}${firstLine(a.email) ? ` (${firstLine(a.email)})` : ''}` : firstLine(a.email) || 'a person');
const svc = a => (a && firstLine(a.description) ? `the service "${clip(a.description, 80)}"` : 'a service');
const sub = a => (a && firstLine(a.name) ? `the subprocessor "${clip(a.name, 80)}"` : 'a subprocessor');
const triggerReason = r => (require('./reassessment').REASON_LABELS[r] || human(r)).toLowerCase();

const msgRole = a => (a.to === 'third_party' ? 'the third party' : a.to === 'client' ? 'the client' : 'the consultant') + (a.recipient_name ? ` (${a.recipient_name})` : '');
const msgKind = a => require('./messages').KIND_LABELS[a.kind] || human(a.kind);

const P = (verb) => ({ who: 'person', verb });
const T = (verb) => ({ who: 'third_party', verb });
const N = (verb) => ({ who: 'none', verb });

const SENTENCES = Object.freeze({
  'assessment.started': P(a => `started the ${(a.type_label ? a.type_label === 'Reassessment' : a.type === 'reassessment') ? 'reassessment' : 'assessment'}`),
  'assessment.scope_saved': P(() => 'saved the scope and answers'),
  'assessment.tier_proposed': P((a, b, o) => `proposed ${a.final_tier ? `tier ${o.tier(a.final_tier)}` : 'a tier'}`),
  'assessment.tier_returned': P(a => `sent the scope back${said(a.comment || a.return_comment)}`),
  'assessment.tier_confirmed': P((a, b, o) => `confirmed ${a.final_tier ? `tier ${o.tier(a.final_tier)}` : 'the tier'}`),
  'assessment.cancelled': P(a => `cancelled the assessment${said(a.reason || a.cancel_reason)}`),
  'assessment.details_updated': P((a, b) => detailsChanged(a, b || {})),
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
  'message.sent': N(a => (a.requested_by_name ? `${a.requested_by_name} sent a reminder to ${msgRole(a)} by email` : `Email sent to ${msgRole(a)}: ${msgKind(a)}`)),
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
  'finding.updated': P((a, b) => {
    const t = a.title || (b && b.title) || a.finding_title;
    const which = t ? `the finding "${clip(t, 120)}"` : 'a finding';
    if (a.status === 'closed') return `closed ${which}${said(a.close_reason)}`;
    if (a.status === 'open' && b && b.status === 'closed') return `reopened ${which}`;
    return `updated ${which}`;
  }),
  'finding.removed': P((a, b) => { const t = (b && b.title) || a.title; return `removed ${t ? `the finding "${clip(t, 120)}"` : 'a finding'}`; }),
  'ai_review.queued': P(() => 'asked Brevis to review'),
  'ai_review.not_configured': N(() => 'Brevis is not set up for this firm: nothing was sent'),
  'ai_review.succeeded': N(a => `Brevis finished its review${a.suggestions != null ? ` with ${plural(a.suggestions, 'suggestion')}` : ''}`),
  'ai_review.failed': N(a => `Brevis's review failed${said(a.error)}`),
  'ai_review.limit_reached': N(() => 'The automatic Brevis review was skipped: 3 runs in 24 hours'),
  'ai_suggestion.accepted': P(a => (a.kind === 'conclusion' ? 'accepted Brevis\'s suggested conclusion' : 'accepted a Brevis suggestion as a finding')),
  'ai_suggestion.edited_accepted': P(() => 'edited a Brevis suggestion and accepted it as a finding'),
  'ai_suggestion.rejected': P(a => `rejected a Brevis suggestion${said(a.reason)}`),
  'contract_review.started': P(() => 'started the contract checklist'),
  'contract_review.vendor_started': T(() => 'opened the contract checklist'),
  'contract_review.vendor_saved': T(a => (Number(a.changed) > 0 ? `marked ${a.changed} contract clause${Number(a.changed) === 1 ? '' : 's'}` : 'marked contract clauses')),
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
  'issue.shared': P(a => `shared the issue "${clip(a.title, 80)}" with the third party`),
  'issue.replied': P(a => `replied on the issue "${clip(a.title, 80)}"`),
  'issue.agreed': P(a => `agreed the fix for "${clip(a.title, 80)}"${a.agreed_date ? `, due ${a.agreed_date}` : ''}${a.condition_added ? ', added as a condition of the draft' : ''}`),
  'third_party.client_details_changed': P(() => 'changed the owner, business unit or volume from the client portal'),
  'third_party.team_changed': P(() => 'changed the owner or reviewer at the firm'),
  'client_request.accepted': P(a => (a.kind === 'reassessment' ? 'started the reassessment the client asked for'
    : `added ${firstLine(a.name) ? `"${clip(a.name, 80)}"` : 'a third party'} from the client's request`)),
  'client_request.reassessment_requested': P(a => `asked for a reassessment from the client portal${a.preferred_date ? `, ideally by ${dayOf(a.preferred_date)}` : ''}`),
  'party_document.added': P(a => `filed ${doc(a)}`),
  'party_document.shared': P(a => `shared ${doc(a)} with the client`),
  'party_document.unshared': P(a => `stopped sharing ${doc(a)} with the client`),
  'party_document.deleted': P((a, b) => `deleted ${doc(b && firstLine(b.title) ? b : a)}`),
  'issue.noted_internally': P(a => `added an internal note on the issue "${clip(a.title, 80)}"`),
  'issue.client_commented': P(a => `commented on the issue "${clip(a.title, 80)}" as the client`),
  'issue.withdrawn': P(a => `withdrew the issue "${clip(a.title, 80)}"`),
  'issue.fix_proposed': T(a => `proposed a fix for "${clip(a.title, 80)}"${said(a.proposed_fix)}`),
  'issue.vendor_replied': T(a => `replied on the issue "${clip(a.title, 80)}"`),
  'questionnaire.comments_added': T(a => `commented on ${(a.questions || []).join(', ')}`),
  'vendor_person.added': P(a => `added ${person(a)} as ${a.role === 'main' ? 'the main contact' : 'a colleague'}`),
  'vendor_person.joined': N(a => `${firstLine(a.name) || firstLine(a.email) ? person(a) : 'A person'} opened their questionnaire link and was added as ${a.role === 'main' ? 'the main contact' : 'a colleague'}`),
  'vendor_person.changed': P(a => `updated the details of ${firstLine(a.name) || 'a person at the third party'}`),
  'vendor_person.removed': P((a, b) => `removed ${(b && b.name) || 'a person'} from the people at the third party`),
  'vendor_person.made_main': P(a => `made ${firstLine(a.name) || 'another person'} the main contact`),
  'third_party.created': P(a => `added the third party${firstLine(a.name) ? ` "${clip(a.name, 80)}"` : ''}`),
  'third_party.imported': P(a => `added the third party${firstLine(a.name) ? ` "${clip(a.name, 80)}"` : ''} from a CSV file${a.file_line ? ` (line ${a.file_line})` : ''}`),
  'third_party.updated': P((a, b) => partyUpdated(a, b || {})),
  'third_party.placement_recalculated': N(a => { const f = fieldList(a, PLACEMENT_WORDS); return `The ${f || 'tier or next review date'} ${f.includes(' and ') ? 'were' : 'was'} worked out again after the client settings changed`; }),
  'third_party.due_date_corrected': N(a => `The next review date was corrected${a.next_due_date ? ` to ${dayOf(a.next_due_date)}` : ''}: the last assessment date plus the review interval`),
  'third_party.tier_assessed': P((a, b, o) => `set the tier to ${a.current_tier ? o.tier(a.current_tier) : 'the assessed tier'} from the confirmed assessment`),
  'third_party.reassessment_triggered': P(a => `recorded a trigger event${a.reason ? ` (${triggerReason(a.reason)})` : ''} and brought the next review forward${a.next_due_date ? ` to ${dayOf(a.next_due_date)}` : ''}`),
  'service.added': P(a => `added ${svc(a)}`),
  'service.updated': P((a, b) => `updated ${svc({ ...b, ...a })}${fieldList(a, SERVICE_WORDS) ? `: ${fieldList(a, SERVICE_WORDS)}` : ''}`),
  'service.removed': P((a, b) => `removed ${svc(b && Object.keys(b).length ? b : a)}`),
  'subprocessor.added': P(a => `added ${sub(a)}`),
  'subprocessor.updated': P((a, b) => `updated ${sub({ ...b, ...a })}`),
  'subprocessor.removed': P((a, b) => `removed ${sub(b && Object.keys(b).length ? b : a)}`),
  'vendor_sections.assigned': T(a => `chose who answers each section${(a.sections || []).filter(s => s.person).length ? `: ${(a.sections || []).filter(s => s.person).map(s => `${s.title} to ${s.person}`).join(', ')}` : ''}`),
});

const FOLD = new Set(['answer.accepted_in_bulk', 'questionnaire.answers_saved', 'recommendation.saved', 'contract_review.updated', 'evidence.uploaded']);

function subjectOf(e, spec) {
  if (e.after_state && e.after_state.by === 'firm') return { name: `${e.after_state.by_name || e.actor_name || 'Someone at the firm'} (for the third party)`, thirdParty: false };
  const thirdParty = !!(e.after_state && e.after_state.by === 'third_party') || (spec && spec.who === 'third_party' && !e.actor_name);
  if (thirdParty) return { name: e.after_state && e.after_state.by_name ? `${e.after_state.by_name} (third party)` : 'The third party', thirdParty: true };
  if (spec && spec.who === 'none') return { name: '', thirdParty: false };
  return { name: e.actor_name || 'Someone no longer in the firm', thirdParty: false };
}

function sentenceOf(e, o, count = 1) {
  const a = e.after_state || {};
  const spec = SENTENCES[e.action];
  const subj = subjectOf(e, spec);
  if (!spec) return { subj, text: `${subj.name ? `${subj.name}: ` : ''}${human(e.action).replace(/\./g, ' ')}` };
  let rest = spec.verb(a, e.before_state || {}, { ...o, count });
  if (e.action === 'message.sent' && o.failedLater && o.failedLater(e)) {
    rest = a.requested_by_name ? `${a.requested_by_name} tried to send a reminder to ${msgRole(a)} by email` : `Tried to email ${msgRole(a)}: ${msgKind(a)}`;
  }
  if (count > 1 && e.action === 'evidence.uploaded') rest = `uploaded ${count} files`;
  else if (count > 1 && e.action !== 'answer.accepted_in_bulk') rest = `${rest.replace(/^saved \d+ answers?/, 'saved answers')} (${count} times)`;
  const text = spec.who === 'none' || !subj.name ? rest : `${subj.name} ${rest}`;
  const tidy = text.replace(/\s{2,}/g, ' ').trim();
  return { subj, text: tidy.charAt(0).toUpperCase() + tidy.slice(1) };
}

function entries(events, { tierLabel = t => t, conclusionLabels = {}, q = '', limit = 200 } = {}) {
  const failed = new Map();
  for (const e of events) {
    const k = e.action === 'message.failed' && e.after_state ? e.after_state.key : null;
    if (k) failed.set(k, Math.max(failed.get(k) || 0, Number(e.chain_seq) || 0));
  }
  const failedLater = e => !!(e.after_state && failed.has(e.after_state.key) && failed.get(e.after_state.key) > (Number(e.chain_seq) || 0));
  const o = { tier: t => (t ? tierLabel(t) : ''), conclusion: c => conclusionLabels[c] || human(c), failedLater };
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
