'use strict';

const rulesLib = require('./answer-rules');
const assembly = require('./questionnaire-assembly');

const TYPE_BY_LABEL = new Map(Object.entries(rulesLib.ANSWER_TYPE_LABELS).map(([k, v]) => [v.toLowerCase(), k]));
const FILE_LABELS = Object.freeze({ none: 'No', yes: 'On Yes', no: 'On No', any: 'On any answer', always: 'Always' });
const FILE_BY_LABEL = new Map(Object.entries(FILE_LABELS).map(([k, v]) => [v.toLowerCase(), k]));
const EXPLAIN_LABELS = Object.freeze({ yes: 'Yes', no: 'No', na: 'Not applicable' });
const OP_WORDS = Object.freeze([
  ['is not answered', 'not_answered'], ['is answered', 'answered'], ['is more than', 'more_than'], ['is less than', 'less_than'],
  ['is not', 'is_not'], ['includes', 'includes'], ['is', 'is'],
]);

const SETTINGS_COLUMNS = Object.freeze([
  { key: 'answer_type', label: 'Answer type', width: 20 },
  { key: 'options', label: 'Options (separate with ;)', width: 30 },
  { key: 'allow_other', label: 'Other allowed (Yes or No)', width: 12 },
  { key: 'allow_na', label: 'Not applicable allowed (Yes or No)', width: 14 },
  { key: 'required', label: 'Required (Yes or No)', width: 12 },
  { key: 'file', label: 'Supporting file (No, On Yes, On No, On any answer)', width: 18 },
  { key: 'evidence', label: 'What the file should be', width: 30 },
  { key: 'evidence_mandatory', label: 'File required (Yes or No)', width: 12 },
  { key: 'explain_on', label: 'Explanation needed for (Yes; No; Not applicable)', width: 20 },
  { key: 'show_when', label: 'Show when (for example: all: GOV-01 is yes; GOV-05 is more than 4)', width: 34 },
]);
const RULE_COLUMNS = Object.freeze([
  { key: 'valid_answer', label: 'Marking rule: a valid answer', width: 32 },
  { key: 'satisfactory', label: 'Marking rule: satisfactory when', width: 32 },
  { key: 'partly', label: 'Marking rule: partly satisfactory when', width: 32 },
  { key: 'red_flags', label: 'Marking rule: red flags', width: 32 },
]);

const yes = b => (b ? 'Yes' : 'No');
const norm = v => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();

function ruleText(rule) {
  if (!rule || !rule.conditions || !rule.conditions.length) return '';
  const word = op => (OP_WORDS.find(([, o]) => o === op) || ['is'])[0];
  const quote = v => (/^[A-Za-z0-9.,-]+$/.test(String(v)) ? String(v) : `"${String(v).replace(/"/g, "'")}"`);
  const parts = rule.conditions.map(c => `${c.question} ${word(c.op)}${['answered', 'not_answered'].includes(c.op) ? '' : ` ${quote(c.value)}`}`);
  return `${rule.mode === 'any' ? 'any' : 'all'}: ${parts.join('; ')}`;
}

function parseRule(text, errors, where) {
  const raw = norm(text);
  if (!raw) return null;
  let mode = 'all';
  let body = raw;
  const m = raw.match(/^(all|any)\s*:\s*/i);
  if (m) { mode = m[1].toLowerCase(); body = raw.slice(m[0].length); }
  const conditions = [];
  for (const part of body.split(';').map(x => x.trim()).filter(Boolean)) {
    const pm = part.match(/^([A-Za-z]{2,6}-\d{1,4})\s+(.+)$/);
    if (!pm) { errors.push(`${where}: "${part}" should start with a question number, for example GOV-01 is yes.`); continue; }
    const rest = pm[2].trim();
    const hit = OP_WORDS.find(([w]) => rest.toLowerCase() === w || rest.toLowerCase().startsWith(`${w} `));
    if (!hit) { errors.push(`${where}: "${part}" should use is, is not, includes, is more than, is less than, is answered or is not answered.`); continue; }
    const raw = rest.slice(hit[0].length).trim();
    const value = /^".*"$/.test(raw) ? raw.slice(1, -1) : raw;
    conditions.push({ question: pm[1].toUpperCase(), op: hit[1], value: ['answered', 'not_answered'].includes(hit[1]) ? '' : value, text: rest });
  }
  return conditions.length ? { mode, conditions } : null;
}

function fileKind(q) {
  if (q.answer_type === 'file') return 'always';
  if (q.answer_type === 'yes_no_na') return q.evidence_on === 'none' ? 'none' : ({ yes: 'yes', no: 'no', any: 'any', answer: 'yes' }[q.evidence_on] || 'yes');
  if (q.answer_type === 'free_text') return q.evidence_on === 'none' ? 'none' : 'any';
  return q.ask_file ? 'any' : 'none';
}

function settingsCells(q) {
  const t = q.answer_type || 'yes_no_na';
  return {
    answer_type: rulesLib.ANSWER_TYPE_LABELS[t] || (t === 'fields' ? 'Several fields' : t),
    options: (q.options || []).join('; '),
    allow_other: ['single_choice', 'multiple_choice'].includes(t) ? yes(q.allow_other) : '',
    allow_na: ['yes_no_na', 'free_text'].includes(t) ? '' : yes(q.allow_na),
    required: yes(q.required !== false),
    file: FILE_LABELS[fileKind(q)],
    evidence: q.evidence || '',
    evidence_mandatory: yes(q.evidence_mandatory),
    explain_on: t === 'yes_no_na' ? ((list => (list.length ? list.map(x => EXPLAIN_LABELS[x]).join('; ') : 'None'))(Array.isArray(q.explain_on) ? q.explain_on : ['no', 'na'])) : '',
    show_when: ruleText(assembly.showWhen(q)),
  };
}

const FIELD_NAMES = Object.freeze({ show_when: 'Shown when', required: 'Answer required', options: 'Options', allow_other: 'Other allowed', allow_na: 'Not applicable allowed',
  evidence_on: 'Supporting file', ask_file: 'Supporting file', explain_on: 'Explanation needed for' });

function fieldText(k, q) {
  const st = settingsCells(q);
  if (k === 'show_when') return st.show_when || 'Always';
  if (k === 'evidence_on' || k === 'ask_file') return st.file;
  if (k in st) return st[k] || 'Not set';
  return null;
}

function ruleCells(g) {
  const x = g || {};
  return { valid_answer: x.valid_answer || '', satisfactory: x.satisfactory || '', partly: x.partly || '', red_flags: x.red_flags || '' };
}

function yesNo(v, where, label, errors) {
  const s = norm(v).toLowerCase();
  if (!s) return null;
  if (['yes', 'y'].includes(s)) return true;
  if (['no', 'n'].includes(s)) return false;
  errors.push(`${where}: ${label} should be Yes or No.`);
  return null;
}

function inputFromCells(get, where, errors, { type: fixedType = null } = {}) {
  const typeLabel = norm(get('answer_type')).toLowerCase();
  const type = fixedType || TYPE_BY_LABEL.get(typeLabel) || (rulesLib.ANSWER_TYPES.includes(typeLabel) ? typeLabel : null);
  if (!type) errors.push(`${where}: Answer type should be one of ${Object.values(rulesLib.ANSWER_TYPE_LABELS).join(', ')}.`);
  const input = { settings_shown: '1', required_shown: '1', answer_type: type || 'yes_no_na' };
  const options = norm(get('options')).split(';').map(x => x.trim()).filter(Boolean);
  if (options.length) input.options = options;
  const other = yesNo(get('allow_other'), where, 'Other allowed', errors);
  if (other) input.allow_other = '1';
  const na = yesNo(get('allow_na'), where, 'Not applicable allowed', errors);
  if (na) input.allow_na = '1';
  const req = yesNo(get('required'), where, 'Required', errors);
  if (req !== false) input.required = '1';
  const fileRaw = norm(get('file')).toLowerCase();
  const file = fileRaw ? FILE_BY_LABEL.get(fileRaw) : (input.answer_type === 'file' ? 'always' : 'none');
  if (!file) errors.push(`${where}: Supporting file should be No, On Yes, On No or On any answer.`);
  if (file && file !== 'none') {
    input.ask_file = '1';
    input.file_when = file === 'always' ? 'any' : file;
  }
  input.evidence = norm(get('evidence'));
  if (yesNo(get('evidence_mandatory'), where, 'File required', errors)) input.evidence_mandatory = '1';
  const explainRaw = norm(get('explain_on'));
  const words = explainRaw.split(';').map(x => x.trim().toLowerCase()).filter(Boolean);
  const map = { yes: 'yes', no: 'no', 'not applicable': 'na', na: 'na', 'n/a': 'na', none: null };
  if (words.some(w => !(w in map))) errors.push(`${where}: Explanation needed for should list Yes, No or Not applicable, separated by ;, or say None.`);
  input.explain_on = words.map(w => map[w]).filter(Boolean);
  if (!explainRaw && input.answer_type === 'yes_no_na') input.explain_on = ['no', 'na'];
  const rule = parseRule(get('show_when'), errors, where);
  if (rule) {
    input.show_mode = 'when';
    input.show_join = rule.mode;
    input.cond_question = rule.conditions.map(c => c.question);
    input.cond_op = rule.conditions.map(c => c.op);
    input.cond_value = rule.conditions.map(c => c.value);
    input.cond_text = rule.conditions.map(c => c.text);
  } else {
    input.show_mode = 'always';
  }
  return input;
}

const canon = v => norm(v).toLowerCase().split(';').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join(';');
const GROUPS = Object.freeze({
  answer: ['options', 'allow_other', 'allow_na', 'file', 'explain_on', 'evidence', 'evidence_mandatory'],
  required: ['required'],
  show: ['show_when'],
});

function changedGroups(get, current, { skip = [] } = {}) {
  const now = settingsCells(current);
  const out = {};
  for (const [g, keys] of Object.entries(GROUPS)) {
    out[g] = keys.filter(k => !skip.includes(k)).some(k => get(k) !== null && get(k) !== undefined && canon(get(k)) !== canon(now[k]));
  }
  return out;
}

function changedInput(get, current, where, errors, { skip = [] } = {}) {
  const groups = changedGroups(get, current, { skip });
  if (!groups.answer && !groups.required && !groups.show) return {};
  const filled = k => {
    const v = get(k);
    return v === null || v === undefined ? settingsCells(current)[k] : v;
  };
  const input = inputFromCells(filled, where, errors, { type: current.answer_type || 'yes_no_na' });
  if (!groups.answer) {
    delete input.settings_shown;
    for (const k of ['options', 'allow_other', 'allow_na', 'ask_file', 'file_when', 'explain_on']) delete input[k];
  }
  for (const k of skip) delete input[k];
  if (!groups.required) { delete input.required_shown; delete input.required; }
  if (!groups.show) for (const k of ['show_mode', 'show_join', 'cond_question', 'cond_op', 'cond_value', 'cond_text']) delete input[k];
  return input;
}

function rulesChanged(get, current) {
  const now = ruleCells(current);
  return RULE_COLUMNS.some(c => get(c.key) !== null && get(c.key) !== undefined && norm(get(c.key)) !== norm(now[c.key]));
}

function fixRuleValues(input, questionOf) {
  if (!Array.isArray(input.cond_question)) return input;
  const words = { yes: 'yes', y: 'yes', no: 'no', n: 'no', na: 'na', 'n/a': 'na', 'not applicable': 'na' };
  const texts = input.cond_text || [];
  input.cond_question.forEach((qid, i) => {
    const parent = questionOf(qid) || {};
    const v = String(input.cond_value[i] || '').trim();
    if (parent.answer_type === 'yes_no_na') { input.cond_value[i] = words[v.toLowerCase()] || v; return; }
    if (!['single_choice', 'multiple_choice'].includes(parent.answer_type)) return;
    const options = parent.options || [];
    const exact = options.find(o => o.toLowerCase() === v.toLowerCase());
    if (exact) { input.cond_value[i] = exact; return; }
    const whole = String(texts[i] || '').trim();
    for (const [w, op] of [['includes', 'includes'], ['is', 'is']]) {
      if (!whole.toLowerCase().startsWith(`${w} `)) continue;
      const rest = whole.slice(w.length).trim().replace(/^"(.*)"$/, '$1');
      const hit = options.find(o => o.toLowerCase() === rest.toLowerCase());
      if (hit) { input.cond_op[i] = op; input.cond_value[i] = hit; return; }
    }
  });
  delete input.cond_text;
  return input;
}

function ruleLengthProblems(get, where) {
  const errors = [];
  for (const c of RULE_COLUMNS) if (norm(get(c.key)).length > 1500) errors.push(`${where}: ${c.label} must be 1500 characters or fewer.`);
  return errors;
}

function rulesFromCells(get, current = null) {
  const now = ruleCells(current);
  const pick = k => (get(k) === null || get(k) === undefined ? now[k] : norm(get(k)));
  return { valid_answer: pick('valid_answer'), satisfactory: pick('satisfactory'), partly: pick('partly'), red_flags: pick('red_flags') };
}

module.exports = { SETTINGS_COLUMNS, RULE_COLUMNS, FILE_LABELS, GROUPS, settingsCells, ruleCells, inputFromCells, rulesFromCells, ruleText, parseRule, norm, canon,
  FIELD_NAMES, fieldText, changedGroups, changedInput, rulesChanged, fixRuleValues, ruleLengthProblems };
