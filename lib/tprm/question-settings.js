'use strict';

const LIMITS = Object.freeze({ evidence: 400, option: 120, options: 30, benchmark: 1000, ai: 1500 });
const CHOICE_TYPES = Object.freeze(['single_choice', 'multiple_choice']);
const FILE_WHEN = Object.freeze({ yes: 'yes', no: 'no', any: 'any' });
const EXPLAIN = Object.freeze(['yes', 'no', 'na']);

const str = v => (v == null ? '' : String(Array.isArray(v) ? v[0] : v)).replace(/\r\n/g, '\n').trim();
const on = v => str(v) === '1';

function cleanOptions(input, errors) {
  const options = [...new Set([].concat(input.options || []).map(o => str(o)).filter(Boolean))];
  if (options.length < 2) errors.push('A choice question needs at least two options.');
  if (options.length > LIMITS.options) errors.push(`At most ${LIMITS.options} options.`);
  if (options.some(o => o.length > LIMITS.option)) errors.push(`An option must be ${LIMITS.option} characters or fewer.`);
  if (options.some(o => o.includes(';'))) errors.push('An option cannot contain a semicolon (;).');
  return options;
}

function answerSettings(type, input, errors, current = {}) {
  const out = {};
  const posted = input.settings_shown !== undefined;
  if (CHOICE_TYPES.includes(type)) {
    out.options = input.options !== undefined || !current.options ? cleanOptions(input, errors) : current.options;
    out.allow_other = posted ? on(input.allow_other) : !!current.allow_other;
  } else {
    out.options = null;
    out.allow_other = null;
  }
  if (!['yes_no_na', 'free_text'].includes(type)) out.allow_na = posted ? on(input.allow_na) : !!current.allow_na;
  else out.allow_na = null;
  if (!posted) return out;
  const askFile = type === 'file' || on(input.ask_file);
  const evidence = askFile ? str(input.evidence) : '';
  if (evidence.length > LIMITS.evidence) errors.push(`What the file should be must be ${LIMITS.evidence} characters or fewer.`);
  out.evidence = evidence;
  out.evidence_mandatory = type === 'file' ? true : askFile && on(input.evidence_mandatory);
  if (type === 'yes_no_na') {
    out.evidence_on = askFile ? (FILE_WHEN[str(input.file_when)] || 'yes') : 'none';
    out.ask_file = null;
    const picked = [].concat(input.explain_on || []).map(x => str(x)).filter(x => EXPLAIN.includes(x));
    out.explain_on = EXPLAIN.filter(x => picked.includes(x));
  } else if (type === 'free_text') {
    out.evidence_on = askFile ? 'text' : 'none';
    out.ask_file = null;
  } else {
    out.evidence_on = null;
    out.ask_file = type === 'file' ? null : askFile;
  }
  return out;
}

function ruleUsesRemoved(questions, id, options) {
  return questions.filter(x => x.show_when && (x.show_when.conditions || []).some(c => c.question === id && c.value && !options.includes(c.value)))
    .map(x => `${x.id} (${x.show_when.conditions.find(c => c.question === id && c.value && !options.includes(c.value)).value})`);
}

module.exports = { LIMITS, CHOICE_TYPES, FILE_WHEN, EXPLAIN, answerSettings, cleanOptions, ruleUsesRemoved };
