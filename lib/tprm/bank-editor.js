'use strict';

const crypto = require('crypto');
const access = require('./access');
const { TprmError } = require('./errors');

const PERMISSION = 'tp.settings';
const ID = /^[A-Z]{2,6}-[0-9]{1,4}$/;
const TIERS = Object.freeze(['All tiers', 'Low', 'Medium', 'High', 'Critical']);
const EDITABLE = Object.freeze(['theme', 'question', 'guidance', 'evidence', 'evidence_mandatory', 'min_tier', 'benchmark', 'iso27001', 'ask_when', 'show_when', 'required',
  'evidence_on', 'explain_on', 'options', 'allow_other', 'allow_na', 'ask_file']);
const ASK_ANSWERS = Object.freeze(['yes', 'no', 'na']);
const NEW_ANSWER_TYPES = Object.freeze(['yes_no_na', 'free_text', 'single_choice', 'multiple_choice', 'date', 'number', 'file', 'url']);
const LIMITS = Object.freeze({ theme: 120, question: 1500, guidance: 2000, evidence: 400, benchmark: 1000, iso27001: 120, ai: 1500, option: 120, options: 30, section: 80 });
const COPIED = Object.freeze(['set', 'pack', 'domain', 'delivery_models', 'answered_by', 'answer_type', 'evidence_on', 'explain_on', 'report_coverage']);
const CODE_IDS = Object.freeze(['AIS-01', 'ASR-01', 'ASR-02', 'ASR-03', 'ASR-05', 'GOV-07', 'RBI-02', 'SEB-05', 'UAE-01', 'UAE-02', 'SAM-01',
  'FTP-01', 'FTP-02', 'FTP-03', 'FTP-04', 'FTP-05', 'FTP-06', 'FTP-07', 'PRM-06', 'GDP-04', 'FIN-03', 'DOR-06', 'DOR-07', 'PFR-02']);

const forbidden = () => new TprmError(403, 'Only a manager can change the question bank.');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });
const conflict = () => new TprmError(409, 'Someone else changed the draft after you opened it. Reload the page and try again.');

function requireEdit(user) {
  if (!access.isFirmUser(user) || !access.firmCan(user, PERMISSION)) throw forbidden();
}

const RULEBOOK_SET = 'Rulebook pack';
const same = (a, b) => {
  const n = x => (x == null || x === '' || x === false ? null : x);
  return JSON.stringify(n(a)) === JSON.stringify(n(b));
};
const sameField = (k, a, b) => (k === 'required' ? (a === false) === (b === false) : same(a, b));

function protectedIds(bank) {
  const assembly = require('./questionnaire-assembly');
  const out = new Set([...CODE_IDS, ...assembly.ALWAYS_INCLUDED, assembly.DELIVERY_QUESTION_ID]);
  const rest = JSON.stringify({ module_triggers: bank.module_triggers, rulebooks: bank.rulebooks });
  for (const m of rest.match(/\b[A-Z]{2,6}-[0-9]{1,4}\b/g) || []) out.add(m);
  return out;
}

async function latest(db) {
  return await db.prepare(`SELECT id, version, label, content, published_at, published_by FROM tp_question_bank_versions ORDER BY version DESC LIMIT 1`).get();
}

async function draftRow(db, { forUpdate = false } = {}) {
  return await db.prepare(`SELECT d.id, d.base_version_id, d.content, d.created_by, d.updated_by, d.updated_at, d.row_version,
      cu.name AS created_by_name, uu.name AS updated_by_name, b.version AS base_version
    FROM tp_question_bank_drafts d LEFT JOIN users cu ON cu.id = d.created_by LEFT JOIN users uu ON uu.id = d.updated_by
    LEFT JOIN tp_question_bank_versions b ON b.id = d.base_version_id ORDER BY d.id LIMIT 1${forUpdate ? ' FOR UPDATE OF d' : ''}`).get() || null;
}

function diff(base, draft) {
  const b = new Map((base.questions || []).map(q => [q.id, q]));
  const d = new Map((draft.questions || []).map(q => [q.id, q]));
  const added = [...d.keys()].filter(id => !b.has(id));
  const retired = [...b.keys()].filter(id => !d.has(id));
  const changed = [];
  for (const [id, q] of d) {
    const o = b.get(id);
    if (!o) continue;
    const fields = EDITABLE.filter(k => !sameField(k, o[k], q[k]));
    if (fields.length) changed.push({ id, fields });
  }
  return { added, retired, changed, count: added.length + retired.length + changed.length };
}

async function everUsedIds(db) {
  const rows = await db.prepare(`SELECT DISTINCT q->>'id' AS id FROM tp_question_bank_versions v, jsonb_array_elements(v.content->'questions') AS q`).all();
  return new Set(rows.map(r => r.id).filter(Boolean));
}

async function history(db, limit = 20) {
  return await db.prepare(`SELECT v.id, v.version, v.label, v.source, v.question_count, v.published_at, u.name AS published_by_name
    FROM tp_question_bank_versions v LEFT JOIN users u ON u.id = v.published_by ORDER BY v.version DESC LIMIT ?`).all(limit);
}

async function inUse(db) {
  const rows = await db.prepare(`SELECT bank_version, COUNT(*)::int AS n FROM tp_questionnaires GROUP BY bank_version`).all();
  return new Map(rows.map(r => [Number(r.bank_version), r.n]));
}

async function state(db) {
  const top = await latest(db);
  const draft = await draftRow(db);
  return { latest: top, draft, diff: draft && top ? diff(top.content, draft.content) : null, stale: !!(draft && top && Number(draft.base_version_id) !== Number(top.id)) };
}

async function startDraft(db, user) {
  requireEdit(user);
  return await db.transaction(async () => {
    const existing = await draftRow(db, { forUpdate: true });
    if (existing) throw new TprmError(409, 'A draft is already open. Continue it, or discard it first.');
    const top = await latest(db);
    if (!top) throw new TprmError(409, 'No question bank version is published yet.');
    const current = new Set((top.content.questions || []).map(q => q.id));
    const gone = [...(await everUsedIds(db))].filter(id => !current.has(id));
    const content = { ...top.content, retired_ids: [...new Set([...(Array.isArray(top.content.retired_ids) ? top.content.retired_ids : []), ...gone])].sort() };
    await db.prepare(`INSERT INTO tp_question_bank_drafts (base_version_id, content, created_by, updated_by) VALUES (?, ?::jsonb, ?, ?)`)
      .run(top.id, JSON.stringify(content), user.id, user.id);
    return { started: true };
  })();
}

async function discard(db, user) {
  requireEdit(user);
  const res = await db.prepare('DELETE FROM tp_question_bank_drafts').run();
  return { discarded: res.changes > 0 };
}

function clean(v, max, label, errors, required = false) {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (!s) { if (required) errors.push(`${label} is required.`); return ''; }
  if (s.length > max) errors.push(`${label} must be ${max} characters or fewer.`);
  return s;
}

function applyValues(q, v) {
  for (const k of EDITABLE) {
    if (v[k] === undefined || sameField(k, q[k], v[k])) continue;
    if (v[k] === null) delete q[k];
    else q[k] = v[k];
  }
}

function editedValues(input, errors, type = null, current = null) {
  const v = {
    theme: clean(input.theme, LIMITS.theme, 'Theme', errors, true),
    question: clean(input.question, LIMITS.question, 'Question', errors, true),
    guidance: clean(input.guidance, LIMITS.guidance, 'Guidance', errors),
    evidence: clean(input.evidence, LIMITS.evidence, 'Evidence asked for', errors),
    benchmark: clean(input.benchmark, LIMITS.benchmark, 'Benchmark', errors),
    iso27001: clean(input.iso27001, LIMITS.iso27001, 'ISO 27001 reference', errors),
    evidence_mandatory: input.evidence_mandatory === '1' || input.evidence_mandatory === 'Yes' || input.evidence_mandatory === true,
    min_tier: String(input.min_tier || ''),
  };
  if (!TIERS.includes(v.min_tier)) errors.push('Choose the lowest tier that is asked this question.');
  if (input.settings_shown !== undefined && type) {
    const st = require('./question-settings').answerSettings(type, input, errors, current || {});
    Object.assign(v, { evidence: st.evidence || '', evidence_mandatory: !!st.evidence_mandatory, evidence_on: st.evidence_on, options: st.options,
      allow_other: st.allow_other || null, allow_na: st.allow_na || null, ask_file: st.ask_file || null });
    if (st.explain_on !== undefined) v.explain_on = st.explain_on;
  }
  if (input.required_shown !== undefined) v.required = String(input.required || '') === '1' ? null : false;
  if (input.show_mode !== undefined) {
    v.ask_when = null;
    v.show_when = null;
    if (String(input.show_mode) === 'when') {
      const qs = [].concat(input.cond_question || []);
      const ops = [].concat(input.cond_op || []);
      const vals = [].concat(input.cond_value || []);
      const conditions = [];
      qs.forEach((raw, i) => {
        const question = String(raw || '').trim().toUpperCase();
        if (!question) return;
        const op = String(ops[i] || '');
        const value = String(vals[i] == null ? '' : vals[i]).trim();
        if (!ID.test(question)) { errors.push('Choose the question each condition uses.'); return; }
        if (!require('./questionnaire-assembly').RULE_OPS.includes(op)) { errors.push('Choose how each condition compares.'); return; }
        if (!['answered', 'not_answered'].includes(op) && !value) errors.push(`Give the value to compare ${question} with.`);
        conditions.push({ question, op, value: ['answered', 'not_answered'].includes(op) ? '' : value.slice(0, 120) });
      });
      if (!conditions.length) errors.push('Add at least one condition, or choose to ask the question always.');
      if (conditions.length > 6) errors.push('At most 6 conditions.');
      v.show_when = { mode: String(input.show_join) === 'any' ? 'any' : 'all', conditions };
    }
  }
  if (input.ask_mode !== undefined) {
    if (String(input.ask_mode) === 'when') {
      const question = String(input.ask_when_question || '').trim().toUpperCase();
      const answer = String(input.ask_when_answer || '').trim();
      if (!ID.test(question)) errors.push('Choose the question this one follows.');
      if (!ASK_ANSWERS.includes(answer)) errors.push('Choose the answer that asks this question.');
      v.ask_when = { question, answer };
    } else {
      v.ask_when = null;
    }
  }
  return v;
}

async function mutate(db, user, input, fn) {
  requireEdit(user);
  return await db.transaction(async () => {
    const draft = await draftRow(db, { forUpdate: true });
    if (!draft) throw new TprmError(409, 'Start a draft first.');
    if (input.row_version !== undefined && input.row_version !== '' && Number(input.row_version) !== Number(draft.row_version)) throw conflict();
    const content = draft.content;
    const result = await fn(content, draft);
    await db.prepare(`UPDATE tp_question_bank_drafts SET content = ?::jsonb, updated_by = ?, updated_at = now(), row_version = row_version + 1 WHERE id = ?`)
      .run(JSON.stringify(content), user.id, draft.id);
    return result;
  })();
}

async function updateQuestion(db, user, id, input = {}) {
  return await mutate(db, user, input, content => {
    const q = (content.questions || []).find(x => x.id === id);
    if (!q) throw new TprmError(404, 'This question is not in the draft.');
    const errors = [];
    const v = editedValues(input, errors, q.answer_type || 'yes_no_na', q);
    if (Array.isArray(v.options)) {
      const gone = require('./question-settings').ruleUsesRemoved(content.questions || [], q.id, v.options);
      if (gone.length) errors.push(`A rule uses an option you removed or renamed: ${gone.join(', ')}. Change ${gone.length === 1 ? 'that rule' : 'those rules'} first.`);
    }
    if (errors.length) throw invalid(errors);
    applyValues(q, v);
    const problems = askProblems(content, q);
    if (problems.length) throw invalid(problems);
    return { id };
  });
}

function nextId(content, prefix) {
  const used = new Set([...(content.questions || []).map(q => q.id), ...(content.retired_ids || [])]);
  let max = 0;
  for (const id of used) { const m = id.match(/^([A-Z]{2,6})-(\d{1,4})$/); if (m && m[1] === prefix) max = Math.max(max, Number(m[2])); }
  for (let n = max + 1; n < 10000; n += 1) { const id = `${prefix}-${String(n).padStart(2, '0')}`; if (!used.has(id)) return id; }
  throw new TprmError(409, `No free number is left for ${prefix}.`);
}

async function addQuestion(db, user, input = {}) {
  const firmCodes = new Set((await db.prepare('SELECT DISTINCT prefix FROM tp_q_templates').all()).map(r => r.prefix));
  return await mutate(db, user, input, content => {
    const like = (content.questions || []).find(x => x.id === String(input.like || ''));
    if (!like) throw invalid(['Choose an existing question to place the new one beside.']);
    if (like.set === RULEBOOK_SET) throw invalid(['Questions for a rulebook are chosen by the rulebook itself, so add new questions to the base set or a module.']);
    const errors = [];
    const type = String(input.answer_type || like.answer_type || 'yes_no_na');
    const v = editedValues(input, errors, type);
    const newSection = String(input.new_section || '').trim();
    let prefix = like.id.split('-')[0];
    if (newSection) {
      if (like.set !== 'Base') errors.push('A new section can only be added to the base questions.');
      if (newSection.length > LIMITS.section) errors.push(`A section name must be ${LIMITS.section} characters or fewer.`);
      if ((content.questions || []).some(x => x.set === 'Base' && String(x.domain).toLowerCase() === newSection.toLowerCase())) errors.push('There is already a section with that name.');
      prefix = String(input.new_prefix || '').trim().toUpperCase();
      if (!/^[A-Z]{2,5}$/.test(prefix)) errors.push('Give the new section a question code of 2 to 5 capital letters, for example BCP.');
      else if ((content.questions || []).some(x => x.id.split('-')[0] === prefix) || (content.retired_ids || []).some(x => x.split('-')[0] === prefix)) errors.push(`${prefix} is already used. Choose another question code.`);
      else if (firmCodes.has(prefix)) errors.push(`${prefix} is already used by a firm questionnaire. Choose another question code.`);
    }
    const extra = input.settings_shown !== undefined ? (NEW_ANSWER_TYPES.includes(type) ? {} : (errors.push('Choose how the question is answered.'), {})) : typeExtras(type, input, errors);
    if (errors.length) throw invalid(errors);
    const id = nextId(content, prefix);
    const q = { id };
    for (const k of COPIED) if (like[k] !== undefined) q[k] = like[k];
    q.answer_type = NEW_ANSWER_TYPES.includes(type) ? type : 'yes_no_na';
    if (q.answer_type !== 'yes_no_na') { delete q.explain_on; delete q.evidence_on; }
    if (q.answer_type === 'yes_no_na') { q.evidence_on = q.evidence_on || 'yes'; q.explain_on = Array.isArray(q.explain_on) ? q.explain_on : ['no', 'na']; }
    q.report_coverage = 'none';
    Object.assign(q, v, extra, { status: 'Added in the tool', change_note: '', source: 'Added on the question bank page' });
    for (const k of Object.keys(q)) if (q[k] === null) delete q[k];
    if (newSection) q.domain = newSection;
    if (newSection) {
      const lastBase = content.questions.map(x => x.set).lastIndexOf('Base');
      content.questions.splice(lastBase + 1, 0, q);
    } else {
      content.questions.splice(content.questions.indexOf(like) + 1, 0, q);
    }
    const problems = askProblems(content, q);
    if (problems.length) throw invalid(problems);
    return { id };
  });
}

async function retireQuestion(db, user, id, input = {}) {
  return await mutate(db, user, input, content => {
    const target = (content.questions || []).find(x => x.id === id);
    if (target && target.set === RULEBOOK_SET) throw new TprmError(409, `${id} belongs to a rulebook, which lists its own questions, so it cannot be retired here.`);
    if (protectedIds(content).has(id)) throw new TprmError(409, `${id} is used by the tool itself (reports, data location, subprocessors or modules), so it cannot be retired.`);
    const children = (content.questions || []).filter(x => (x.ask_when && x.ask_when.question === id) || (x.show_when && (x.show_when.conditions || []).some(c => c.question === id))).map(x => x.id);
    if (children.length) throw new TprmError(409, `${children.join(', ')} ${children.length === 1 ? 'is' : 'are'} asked only after ${id}. Change ${children.length === 1 ? 'that question' : 'those questions'} to be asked always first.`);
    const at = (content.questions || []).findIndex(x => x.id === id);
    if (at === -1) throw new TprmError(404, 'This question is not in the draft.');
    content.questions.splice(at, 1);
    content.retired_ids = [...new Set([...(content.retired_ids || []), id])];
    return { id };
  });
}

async function restoreQuestion(db, user, id, input = {}) {
  return await mutate(db, user, input, async (content, draft) => {
    const base = await db.prepare('SELECT content FROM tp_question_bank_versions WHERE id = ?').get(draft.base_version_id);
    const q = base && (base.content.questions || []).find(x => x.id === id);
    if (!q || (content.questions || []).some(x => x.id === id)) throw new TprmError(404, 'Only a question retired in this draft can be brought back.');
    const order = base.content.questions.map(x => x.id);
    let at = content.questions.length;
    for (let i = order.indexOf(id) + 1; i < order.length; i += 1) { const k = content.questions.findIndex(x => x.id === order[i]); if (k !== -1) { at = k; break; } }
    content.questions.splice(at, 0, q);
    content.retired_ids = (content.retired_ids || []).filter(x => x !== id);
    return { id };
  });
}

function ruleProblems(content, q) {
  const errors = [];
  const rule = q.show_when;
  if (!rule) return errors;
  const all = content.questions || [];
  const at = all.indexOf(q);
  for (const c of rule.conditions || []) {
    const parent = all.find(x => x.id === c.question);
    if (!parent || parent.id === q.id) { errors.push(`${q.id}: its rule uses ${c.question}, which is not in the bank.`); continue; }
    if (all.indexOf(parent) > at) errors.push(`${q.id}: its rule uses ${parent.id}, which comes after it. A rule can only use questions asked before it.`);
    if (parent.set !== q.set || (parent.pack || null) !== (q.pack || null) || (q.set === 'Base' && parent.domain !== q.domain)) {
      errors.push(`${q.id}: its rule can only use questions in the same section, and ${parent.id} is not.`);
    }
    if (['answered', 'not_answered'].includes(c.op)) continue;
    const t = parent.answer_type || 'yes_no_na';
    if (['free_text', 'url', 'file'].includes(t)) errors.push(`${q.id}: ${parent.id} has no fixed answers, so a rule can only check whether it is answered.`);
    else if (t === 'yes_no_na' && (!['is', 'is_not'].includes(c.op) || !['yes', 'no', 'na'].includes(c.value))) errors.push(`${q.id}: for ${parent.id} use "is" or "is not" with yes, no or na.`);
    else if (['single_choice', 'multiple_choice'].includes(t) && (!['is', 'is_not', 'includes'].includes(c.op) || !(parent.options || []).includes(c.value))) {
      errors.push(`${q.id}: "${c.value}" is not one of the options of ${parent.id}. Use one exactly as written: ${(parent.options || []).join(', ')}.`);
    } else if (t === 'number' && !/^-?\d+(?:[.,]\d+)?$/.test(c.value)) errors.push(`${q.id}: for ${parent.id} the value must be a number.`);
    else if (t === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(c.value)) errors.push(`${q.id}: for ${parent.id} the value must be a date written YYYY-MM-DD.`);
  }
  if (q.set === RULEBOOK_SET) errors.push(`${q.id}: a rulebook question is always asked.`);
  if (protectedIds(content).has(q.id)) errors.push(`${q.id}: it is used by the tool itself, so it is always asked.`);
  return errors;
}

function typeExtras(type, input, errors) {
  const out = {};
  if (!NEW_ANSWER_TYPES.includes(type)) { errors.push('Choose how the question is answered.'); return out; }
  if (['single_choice', 'multiple_choice'].includes(type)) {
    const options = [...new Set([].concat(input.options || []).map(o => String(o || '').trim()).filter(Boolean))];
    if (options.length < 2) errors.push('A choice question needs at least two options.');
    if (options.length > LIMITS.options) errors.push(`At most ${LIMITS.options} options.`);
    if (options.some(o => o.length > LIMITS.option)) errors.push(`An option must be ${LIMITS.option} characters or fewer.`);
    if (options.some(o => o.includes(';'))) errors.push('An option cannot contain a semicolon (;).');
    out.options = options;
    if (String(input.allow_other || '') === '1') out.allow_other = true;
  }
  if (!['yes_no_na', 'free_text'].includes(type)) {
    if (String(input.allow_na || '') === '1') out.allow_na = true;
    if (type !== 'file' && (String(input.ask_file || '') === '1' || String(input.evidence || '').trim())) out.ask_file = true;
  }
  return out;
}

function askProblems(content, q) {
  const errors = [];
  if (q.required === false && protectedIds(content).has(q.id)) errors.push(`${q.id}: it is used by the tool itself, so it is always required.`);
  if (q.show_when) return [...errors, ...ruleProblems(content, q)];
  if (!q.ask_when) return errors;
  const w = q.ask_when;
  const parent = (content.questions || []).find(x => x.id === w.question);
  if (!parent || parent.id === q.id) errors.push(`${q.id}: it follows ${w.question}, which is not in the bank.`);
  else {
    if (parent.answer_type !== 'yes_no_na') errors.push(`${q.id}: it can only follow a Yes, No or Not applicable question, and ${parent.id} is not one.`);
    if (parent.ask_when) errors.push(`${q.id}: ${parent.id} is itself a follow-up, and a follow-up cannot have follow-ups of its own.`);
    if (parent.set !== q.set || (parent.pack || null) !== (q.pack || null) || (q.set !== 'Module' && parent.domain !== q.domain)) {
      errors.push(`${q.id}: it must be in the same set, module and domain as ${parent.id}.`);
    }
  }
  if (!ASK_ANSWERS.includes(w.answer)) errors.push(`${q.id}: the answer that asks it is not valid.`);
  if (q.set === RULEBOOK_SET) errors.push(`${q.id}: a rulebook question cannot be a follow-up.`);
  if (protectedIds(content).has(q.id)) errors.push(`${q.id}: it is used by the tool itself, so it is always asked.`);
  if ((content.questions || []).some(x => x.ask_when && x.ask_when.question === q.id)) errors.push(`${q.id}: other questions follow it, so it cannot be a follow-up itself.`);
  return errors;
}

function baseSections(content) {
  const seen = [];
  for (const x of content.questions || []) if (x.set === 'Base' && !seen.includes(x.domain)) seen.push(x.domain);
  return seen;
}

async function renameSection(db, user, input = {}) {
  return await mutate(db, user, input, content => {
    const from = String(input.section || '');
    const to = String(input.title || '').trim();
    const errors = [];
    if (!baseSections(content).includes(from)) errors.push('This section is not in the base questions.');
    if (!to) errors.push('Give the section a name.');
    if (to.length > LIMITS.section) errors.push(`A section name must be ${LIMITS.section} characters or fewer.`);
    if (to.toLowerCase() !== from.toLowerCase() && baseSections(content).some(d => d.toLowerCase() === to.toLowerCase())) errors.push('There is already a section with that name.');
    if (errors.length) throw invalid(errors);
    for (const x of content.questions) if (x.set === 'Base' && x.domain === from) x.domain = to;
    return { section: to };
  });
}

async function moveSection(db, user, input = {}) {
  return await mutate(db, user, input, content => {
    const order = baseSections(content);
    const at = order.indexOf(String(input.section || ''));
    if (at < 0) throw invalid(['This section is not in the base questions.']);
    const to = at + (input.dir === 'up' ? -1 : 1);
    if (to < 0 || to >= order.length) return { section: order[at] };
    [order[at], order[to]] = [order[to], order[at]];
    const base = content.questions.filter(x => x.set === 'Base');
    const sorted = order.flatMap(d => base.filter(x => x.domain === d));
    let k = 0;
    content.questions = content.questions.map(x => (x.set === 'Base' ? sorted[k++] : x));
    return { section: order[to] };
  });
}

function validate(base, content, everUsed = null) {
  const errors = [];
  const ids = (content.questions || []).map(q => q.id);
  if (new Set(ids).size !== ids.length) errors.push('A question number appears twice.');
  const retired = new Set(content.retired_ids || []);
  const baseById = new Map((base.questions || []).map(q => [q.id, q]));
  for (const q of content.questions || []) {
    if (!ID.test(q.id)) errors.push(`${q.id}: not a question number.`);
    if (retired.has(q.id) || (everUsed && everUsed.has(q.id) && !baseById.has(q.id))) errors.push(`${q.id}: this number was retired and cannot be used again.`);
    if (!String(q.question || '').trim()) errors.push(`${q.id}: the question is empty.`);
    if (!TIERS.includes(q.min_tier)) errors.push(`${q.id}: the tier is not valid.`);
    const o = baseById.get(q.id);
    if (o && o.answer_type !== q.answer_type) errors.push(`${q.id}: the answer type cannot change once published.`);
    if (o && JSON.stringify(o.fields || null) !== JSON.stringify(q.fields || null)) errors.push(`${q.id}: its answer fields cannot change once published.`);
    errors.push(...askProblems(content, q));
  }
  for (const id of protectedIds(base)) if (baseById.has(id) && !ids.includes(id)) errors.push(`${id} is used by the tool itself and cannot be removed.`);
  for (const q of base.questions || []) if (q.set === RULEBOOK_SET && !ids.includes(q.id)) errors.push(`${q.id} belongs to a rulebook and cannot be removed.`);
  {
    const assembly = require('./questionnaire-assembly');
    const left = new Set(assembly.moduleCatalog(content));
    for (const m of assembly.moduleCatalog(base)) if (!left.has(m)) errors.push(`The ${m} module would have no questions left. Keep at least one.`);
  }
  if (!errors.length) {
    const assembly = require('./questionnaire-assembly');
    try {
      const modules = assembly.offeredModules(content);
      const packs = [...new Set((content.questions || []).filter(q => q.set === RULEBOOK_SET).map(q => q.pack))];
      for (const tier of ['low', 'medium', 'high', 'critical']) {
        for (const deliveryModel of assembly.DELIVERY_MODELS) {
          assembly.assemble(content, { tier, deliveryModel });
          assembly.assemble(content, { tier, deliveryModel, modules });
          assembly.assemble(content, { tier, deliveryModel, rulebooks: packs });
        }
      }
    } catch (err) {
      errors.push(`The questionnaire could not be put together: ${err.message}`);
    }
  }
  return errors;
}

async function importRows(db, user, rows) {
  requireEdit(user);
  const sheet = require('./question-sheet');
  const started = !(await draftRow(db));
  if (started) await startDraft(db, user);
  let out;
  try {
    out = await mutate(db, user, {}, content => {
      const byId = new Map((content.questions || []).map(q => [q.id, q]));
      const keep = protectedIds(content);
      const questionOf = id => byId.get(String(id || '').toUpperCase());
      const errors = [];
      const plan = [];
      for (const row of rows) {
        const q = byId.get(row.id);
        if (!q) { errors.push(`${row.id}: not in the question bank. New questions are added on the page.`); continue; }
        if (row.retire) {
          if (q.set === RULEBOOK_SET || keep.has(row.id)) errors.push(`${row.id}: used by the tool itself, so it cannot be retired.`);
          else plan.push({ retire: row.id });
          continue;
        }
        const rowErrors = [];
        const cells = row.cells || {};
        const get = k => (cells[k] === undefined ? null : cells[k]);
        if (get('answer_type') !== null && sheet.canon(get('answer_type')) && sheet.canon(get('answer_type')) !== sheet.canon(sheet.settingsCells(q).answer_type)) {
          rowErrors.push('how it is answered cannot change in the file. Add a new question on the page instead.');
        }
        const extra = sheet.fixRuleValues(sheet.changedInput(get, q, row.id, rowErrors, { skip: ['evidence', 'evidence_mandatory'] }), questionOf);
        const input = { ...row.values, ...extra };
        const v = editedValues(input, rowErrors, extra.settings_shown !== undefined ? (q.answer_type || 'yes_no_na') : null, q);
        if (Array.isArray(v.options)) {
          const gone = require('./question-settings').ruleUsesRemoved(content.questions || [], q.id, v.options);
          if (gone.length) rowErrors.push(`a rule uses an option you removed or renamed: ${gone.join(', ')}.`);
        }
        errors.push(...rowErrors.map(e => (e.startsWith(`${row.id}:`) ? e : `${row.id}: ${e}`)));
        if (!rowErrors.length) plan.push({ q, v });
      }
      if (errors.length) throw invalid(errors.slice(0, 20));
      let changed = 0;
      let retired = 0;
      const touched = [];
      for (const p of plan) {
        if (p.retire) {
          content.questions = content.questions.filter(x => x.id !== p.retire);
          content.retired_ids = [...new Set([...(content.retired_ids || []), p.retire])];
          retired += 1;
        } else if (EDITABLE.some(k => p.v[k] !== undefined && !sameField(k, p.q[k], p.v[k]))) {
          applyValues(p.q, p.v);
          touched.push(p.q);
          changed += 1;
        }
      }
      const problems = touched.flatMap(q => askProblems(content, q));
      if (problems.length) throw invalid([...new Set(problems)].slice(0, 20));
      return { changed, retired, rows: rows.length };
    });
  } catch (err) {
    if (started) await discard(db, user);
    throw err;
  }
  if (started && !out.changed && !out.retired) await discard(db, user);
  return out;
}

async function publish(db, user, input = {}) {
  requireEdit(user);
  return await db.transaction(async () => {
    await db.lockChain('tprm:question-bank-publish');
    const draft = await draftRow(db, { forUpdate: true });
    if (!draft) throw new TprmError(409, 'There is no draft to publish.');
    if (input.row_version !== undefined && input.row_version !== '' && Number(input.row_version) !== Number(draft.row_version)) throw conflict();
    const top = await latest(db);
    if (!top || Number(top.id) !== Number(draft.base_version_id)) {
      throw new TprmError(409, 'A newer version was published after this draft was started. Discard the draft and start again from the latest version.');
    }
    const d = diff(top.content, draft.content);
    if (!d.count) throw new TprmError(409, 'The draft has no changes to publish.');
    const errors = validate(top.content, draft.content, await everUsedIds(db));
    if (errors.length) throw invalid(errors);
    const version = Number(top.version) + 1;
    const day = new Date().toISOString().slice(0, 10);
    const label = `${day} version ${version}`;
    const content = { ...draft.content, version: label };
    const raw = JSON.stringify(content);
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    const note = String(input.note || '').trim().slice(0, 300);
    const source = `Edited on the question bank page from version ${top.version}: ${d.added.length} added, ${d.changed.length} changed, ${d.retired.length} retired${note ? `. ${note}` : ''}`.slice(0, 1000);
    const row = await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, source, content, content_sha256, question_count, published_by)
      VALUES (?, ?, ?, ?::jsonb, ?, ?, ?) RETURNING id`).get(version, label, source, raw, sha, content.questions.length, user.id);
    await db.prepare('DELETE FROM tp_question_bank_drafts WHERE id = ?').run(draft.id);
    return { id: Number(row.id), version, label, diff: d };
  })();
}

module.exports = { baseSections, renameSection, moveSection,
  ASK_ANSWERS, NEW_ANSWER_TYPES,
  PERMISSION, TIERS, EDITABLE, LIMITS, CODE_IDS,
  RULEBOOK_SET, protectedIds, latest, importRows, history, inUse, everUsedIds, draftRow, diff, state, startDraft, discard, updateQuestion, addQuestion, retireQuestion, restoreQuestion, validate, publish, nextId,
};
