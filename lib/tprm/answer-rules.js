'use strict';

const LEGACY_RESPONSES = Object.freeze(['yes', 'partial', 'no', 'na']);
const RESPONSE_LABELS = Object.freeze({ yes: 'Yes', partial: 'Partially', no: 'No', na: 'Not applicable', text: 'Written answer', value: 'Answered' });
const ANSWER_TYPES = Object.freeze(['yes_no_na', 'free_text', 'single_choice', 'multiple_choice', 'date', 'number', 'file', 'url']);
const ANSWER_TYPE_LABELS = Object.freeze({ yes_no_na: 'Yes, No, Not applicable', free_text: 'Written answer', single_choice: 'Single choice',
  multiple_choice: 'Multiple choice', date: 'Date', number: 'Number', file: 'File upload', url: 'Web link' });
const VALUE_KINDS = Object.freeze({ single_choice: 'choice', multiple_choice: 'multi', date: 'date', number: 'number', url: 'url', file: null });
const isValueType = t => Object.prototype.hasOwnProperty.call(VALUE_KINDS, t);
const OTHER_FIELD = Object.freeze({ key: 'other', label: 'Other, in your words', kind: 'short', optional: true, max: 300 });
const KINDS = Object.freeze(['iso27001', 'soc2_type2']);
const KIND_LABELS = Object.freeze({ iso27001: 'ISO 27001 certificate', soc2_type2: 'SOC 2 Type II report' });
const KIND_SHORT = Object.freeze({ iso27001: 'ISO 27001', soc2_type2: 'SOC 2' });
const REPORT_QUESTIONS = Object.freeze({
  iso27001: Object.freeze({ question: 'ASR-01', extra: 'ASR-02' }),
  soc2_type2: Object.freeze({ question: 'ASR-03', extra: 'ASR-05' }),
});
const REPORT_PERIOD_FIELD = Object.freeze({ key: 'period_end', label: 'Report period end date', kind: 'date', optional: true, max: 10 });
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

const FIELD_KINDS = Object.freeze(['short', 'long', 'date', 'number', 'multi', 'choice', 'url']);
const FIELD_LIMITS = Object.freeze({ short: 300, long: 1500, date: 10, number: 20, multi: 1000, choice: 300, url: 500 });
const MULTI_SEPARATOR = '; ';
const OPTIONAL_FIELD = /\bif (?:any|used|outsourced|no escrow|there is one)\b/i;
function fieldDefs(r) {
  if (!Array.isArray(r.fields)) return [];
  return r.fields.filter(f => f && f.key && f.label).map(f => {
    const options = Array.isArray(f.options) ? [...new Set(f.options.map(o => String(o).trim()).filter(o => o && !o.includes(';')))] : [];
    const kind = FIELD_KINDS.includes(f.kind) && (!['multi', 'choice'].includes(f.kind) || options.length) ? f.kind : 'short';
    return { key: String(f.key), label: String(f.label), kind, optional: OPTIONAL_FIELD.test(String(f.label)), max: FIELD_LIMITS[kind], ...(['multi', 'choice'].includes(kind) ? { options } : {}) };
  });
}
function fieldShape(r, type) {
  const fields = fieldDefs(r);
  if (r.id === REPORT_QUESTIONS.soc2_type2.question && type === 'yes_no_na' && fields.length && !fields.some(f => f.key === REPORT_PERIOD_FIELD.key)) {
    fields.splice(1, 0, { ...REPORT_PERIOD_FIELD });
  }
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
  return fields.filter(f => String((values || {})[f.key] || '').trim()).map(f => (f.label ? `${f.label}: ${shown(f)}` : shown(f))).join('\n');
}

function questionRules(row = {}) {
  const r = row || {};
  const base = {
    required: r.required !== false,
    evidenceMandatory: !!r.evidence_mandatory,
    coverage: COVERAGES.includes(r.report_coverage) ? r.report_coverage : 'none',
    benchmark: r.benchmark ? String(r.benchmark) : null,
  };
  if (!r.answer_type) {
    return { ...base, typed: false, type: 'yes_no_na', responses: LEGACY_RESPONSES, explainOn: ['partial', 'no', 'na'], evidenceOn: ['yes', 'partial'], coverage: 'none',
      fields: [], fieldsOn: null, detailsOnYes: null };
  }
  if (isValueType(r.answer_type)) {
    const t = r.answer_type;
    const kind = VALUE_KINDS[t];
    const options = Array.isArray(r.options) ? [...new Set(r.options.map(o => String(o).trim()).filter(o => o && !o.includes(';')))] : [];
    const fields = kind ? [{ key: 'value', label: '', kind, optional: !!(r.allow_other && ['choice', 'multi'].includes(kind)), max: FIELD_LIMITS[kind], ...(['multi', 'choice'].includes(kind) ? { options } : {}) }] : [];
    if (kind && ['choice', 'multi'].includes(kind) && r.allow_other) fields.push({ ...OTHER_FIELD });
    const allowNa = !!r.allow_na;
    return { ...base, typed: true, type: t, valueType: t, responses: allowNa ? ['value', 'na'] : ['value'], explainOn: allowNa ? ['na'] : [],
      evidenceOn: t === 'file' || r.ask_file ? ['value'] : [], evidenceMandatory: t === 'file' || (!!r.ask_file && !!r.evidence_mandatory),
      fields, fieldsOn: kind ? 'answer' : null, detailsOnYes: null };
  }
  if (r.answer_type === 'free_text') {
    return { ...base, typed: true, type: 'free_text', responses: ['text', 'na'], explainOn: ['na'], evidenceOn: r.evidence_on === 'none' ? [] : ['text'], ...fieldShape(r, 'free_text') };
  }
  const on = { yes: ['yes'], no: ['no'], answer: ['yes'], any: ['yes', 'no'], none: [] }[r.evidence_on] || ['yes'];
  return { ...base, typed: true, type: 'yes_no_na', responses: ['yes', 'no', 'na'], explainOn: list(r.explain_on) || ['no', 'na'], evidenceOn: on,
    ...fieldShape(r, 'yes_no_na') };
}

const fieldsResponse = rules => (rules.valueType ? 'value' : rules.fieldsOn === 'answer' ? 'text' : rules.fieldsOn === 'yes' || rules.detailsOnYes ? 'yes' : null);

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

function choiceValue(field, raw) {
  const v = String(raw == null ? '' : Array.isArray(raw) ? raw[0] : raw).trim();
  return { value: field.options.includes(v) ? v : '', unknown: v && !field.options.includes(v) ? [v] : [] };
}

const URL_VALUE = /^https?:\/\/[^\s<>"]{3,}$/i;

function multiValue(field, raw) {
  const list = (Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/;|\n/)).map(x => String(x).trim()).filter(Boolean);
  const unknown = list.filter(x => !field.options.includes(x));
  return { value: field.options.filter(o => list.includes(o)).join(MULTI_SEPARATOR), unknown };
}

module.exports = {
  REPORT_QUESTIONS,
  MULTI_SEPARATOR, multiValue, choiceValue, URL_VALUE,
  ANSWER_TYPES, ANSWER_TYPE_LABELS, VALUE_KINDS, isValueType,
  FIELD_KINDS, FIELD_LIMITS, renderFields, fieldsResponse,
  LEGACY_RESPONSES, RESPONSE_LABELS, KINDS, KIND_LABELS, KIND_SHORT, COVERAGES, COVERAGE_LABELS, STATES, WAIVED,
  questionRules, bankTyped, responseValid, evidenceApplies, explanationNeeded, activeReports, coveringKinds,
  evidenceState, isWaived, vendorBadge, coverageCounts, wouldCover,
};
