'use strict';

const LEGACY_RESPONSES = Object.freeze(['yes', 'partial', 'no', 'na']);
const RESPONSE_LABELS = Object.freeze({ yes: 'Yes', partial: 'Partially', no: 'No', na: 'Not applicable', text: 'Written answer' });
const KINDS = Object.freeze(['iso27001', 'soc2_type2']);
const KIND_LABELS = Object.freeze({ iso27001: 'ISO 27001 certificate', soc2_type2: 'SOC 2 Type II report' });
const KIND_SHORT = Object.freeze({ iso27001: 'ISO 27001', soc2_type2: 'SOC 2' });
const COVERAGES = Object.freeze(['iso', 'soc2', 'either', 'both', 'none']);
const COVERAGE_LABELS = Object.freeze({
  iso: 'ISO 27001 certificate', soc2: 'SOC 2 report', either: 'ISO 27001 certificate or SOC 2 report',
  both: 'ISO 27001 certificate and SOC 2 report together', none: 'Not covered by a report',
});

const STATES = Object.freeze({
  not_answered: 'Not answered',
  not_needed: 'Not needed for this answer',
  optional: 'Optional, none given',
  provided: 'Provided',
  provided_in_clarification: 'Provided in a clarification',
  waived_iso: 'Waived: ISO 27001 certificate',
  waived_soc2: 'Waived: SOC 2 report',
  waived_both: 'Waived: ISO 27001 and SOC 2',
  requested: 'Asked for in a clarification',
  missing: 'Missing',
});

const list = v => (Array.isArray(v) ? v.map(String) : null);

const FIELD_KINDS = Object.freeze(['short', 'long', 'date', 'number']);
const FIELD_LIMITS = Object.freeze({ short: 300, long: 1500, date: 10, number: 20 });
const OPTIONAL_FIELD = /\bif (?:any|used|outsourced|no escrow|there is one)\b/i;
function fieldDefs(r) {
  if (!Array.isArray(r.fields)) return [];
  return r.fields.filter(f => f && f.key && f.label).map(f => {
    const kind = FIELD_KINDS.includes(f.kind) ? f.kind : 'short';
    return { key: String(f.key), label: String(f.label), kind, optional: OPTIONAL_FIELD.test(String(f.label)), max: FIELD_LIMITS[kind] };
  });
}
function fieldShape(r, type) {
  const fields = fieldDefs(r);
  const fieldsOn = fields.length ? (type === 'yes_no_na' && r.fields_on === 'yes' ? 'yes' : type === 'free_text' && r.fields_on !== 'yes' ? 'answer' : null) : null;
  return {
    fields: fieldsOn ? fields : [],
    fieldsOn,
    detailsOnYes: type === 'yes_no_na' && r.details_on_yes && r.details_on_yes.label ? String(r.details_on_yes.label) : null,
  };
}
function renderFields(fields, values) {
  const shown = f => {
    const v = String(values[f.key]).trim();
    return f.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? (require('./format').day(v, 'UTC') || v) : v;
  };
  return fields.filter(f => String((values || {})[f.key] || '').trim()).map(f => `${f.label}: ${shown(f)}`).join('\n');
}

function questionRules(row = {}) {
  const r = row || {};
  const base = {
    evidenceMandatory: !!r.evidence_mandatory,
    coverage: COVERAGES.includes(r.report_coverage) ? r.report_coverage : 'none',
    benchmark: r.benchmark ? String(r.benchmark) : null,
  };
  if (!r.answer_type) {
    return { ...base, typed: false, type: 'yes_no_na', responses: LEGACY_RESPONSES, explainOn: ['partial', 'no', 'na'], evidenceOn: ['yes', 'partial'], coverage: 'none',
      fields: [], fieldsOn: null, detailsOnYes: null };
  }
  if (r.answer_type === 'free_text') {
    return { ...base, typed: true, type: 'free_text', responses: ['text', 'na'], explainOn: ['na'], evidenceOn: ['text'], ...fieldShape(r, 'free_text') };
  }
  const on = { yes: 'yes', no: 'no', answer: 'yes' }[r.evidence_on] || 'yes';
  return { ...base, typed: true, type: 'yes_no_na', responses: ['yes', 'no', 'na'], explainOn: list(r.explain_on) || ['no', 'na'], evidenceOn: [on],
    ...fieldShape(r, 'yes_no_na') };
}

const fieldsResponse = rules => (rules.fieldsOn === 'answer' ? 'text' : rules.fieldsOn === 'yes' || rules.detailsOnYes ? 'yes' : null);

const bankTyped = bank => !!(bank && Array.isArray(bank.questions) && bank.questions.some(q => q && q.answer_type));

const responseValid = (rules, response) => rules.responses.includes(response);

const evidenceApplies = (rules, response) => !!response && rules.evidenceOn.includes(response);
const explanationNeeded = (rules, response) => !!response && rules.explainOn.includes(response);

function activeReports(reports = []) {
  const out = {};
  for (const r of reports || []) if (r && KINDS.includes(r.kind) && r.check_status !== 'rejected') out[r.kind] = r;
  return out;
}

function coveringKinds(rules, questionId, reports = []) {
  const active = activeReports(reports);
  const soc2 = active.soc2_type2 && !(active.soc2_type2.exception_question_ids || []).includes(questionId) ? active.soc2_type2 : null;
  const iso = active.iso27001 || null;
  switch (rules.coverage) {
    case 'iso': return iso ? ['iso27001'] : [];
    case 'soc2': return soc2 ? ['soc2_type2'] : [];
    case 'either': return [iso && 'iso27001', soc2 && 'soc2_type2'].filter(Boolean);
    case 'both': return iso && soc2 ? ['iso27001', 'soc2_type2'] : [];
    default: return [];
  }
}

function evidenceState({ rules, questionId, response, ownEvidence = false, reports = [], request = null }) {
  const out = (key, extra = {}) => ({ key, label: STATES[key], required: false, covered: [], ...extra });
  if (!response) return out('not_answered');
  if (!evidenceApplies(rules, response)) return out('not_needed');
  if (ownEvidence) return out('provided');
  if (!rules.evidenceMandatory) return out('optional');
  if (request && request.responded) return out('provided_in_clarification');
  const covered = coveringKinds(rules, questionId, reports);
  if (covered.length === 2) return out('waived_both', { covered });
  if (covered.length === 1) return out(covered[0] === 'iso27001' ? 'waived_iso' : 'waived_soc2', { covered });
  if (request && request.status !== 'closed') return out('requested', { required: true });
  return out('missing', { required: true });
}

const WAIVED = Object.freeze(['waived_iso', 'waived_soc2', 'waived_both']);
const isWaived = key => WAIVED.includes(key);

function vendorBadge(rules, questionId, reports = []) {
  const covered = coveringKinds(rules, questionId, reports);
  if (rules.evidenceMandatory && covered.length) {
    return {
      key: 'covered',
      label: covered.length === 2 ? 'Covered by your ISO 27001 certificate and SOC 2 report'
        : covered[0] === 'iso27001' ? 'Covered by your ISO 27001 certificate' : 'Covered by your SOC 2 report',
    };
  }
  if (rules.evidenceMandatory) {
    if (rules.typed && rules.type === 'yes_no_na' && rules.evidenceOn[0] === 'no') return { key: 'required', label: 'Evidence required if No' };
    return { key: 'required', label: 'Evidence required' };
  }
  return { key: 'optional', label: 'Evidence optional' };
}

function coverageCounts(rows, reports) {
  const counts = { iso27001: 0, soc2_type2: 0, total: 0 };
  for (const row of rows) {
    const rules = questionRules(row);
    if (!rules.evidenceMandatory) continue;
    const kinds = coveringKinds(rules, row.id, reports);
    if (kinds.length) counts.total += 1;
    for (const k of kinds) counts[k] += 1;
  }
  return counts;
}

function wouldCover(rows, kind) {
  const fake = [{ kind, check_status: 'pending', exception_question_ids: [] }];
  return coverageCounts(rows, fake)[kind];
}

module.exports = {
  FIELD_KINDS, FIELD_LIMITS, renderFields, fieldsResponse,
  LEGACY_RESPONSES, RESPONSE_LABELS, KINDS, KIND_LABELS, KIND_SHORT, COVERAGES, COVERAGE_LABELS, STATES, WAIVED,
  questionRules, bankTyped, responseValid, evidenceApplies, explanationNeeded, activeReports, coveringKinds,
  evidenceState, isWaived, vendorBadge, coverageCounts, wouldCover,
};
