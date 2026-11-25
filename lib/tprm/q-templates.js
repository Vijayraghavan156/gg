'use strict';

const access = require('./access');
const { TprmError } = require('./errors');
const rulesLib = require('./answer-rules');
const assembly = require('./questionnaire-assembly');

const PERMISSION = 'tp.settings';
const SET_NAME = 'Firm questionnaire';
const MODES = Object.freeze(['automatic', 'instead', 'with']);
const MODE_LABELS = Object.freeze({ automatic: 'The automatic questionnaire, by tier and service', instead: 'One of your questionnaires instead: no automatic questions, modules or AI screening question; the client\'s rulebook questions are still asked unless you untick them', with: 'The automatic questionnaire and one of yours' });
const LIMITS = Object.freeze({ name: 80, description: 200, section: 80, theme: 120, question: 1500, guidance: 2000, evidence: 400, option: 120, options: 30, benchmark: 1000,
  ai: 1500, conditions: 6, questions: 300, sections: 40 });
const CHOICE_TYPES = Object.freeze(['single_choice', 'multiple_choice']);

const forbidden = () => new TprmError(403, 'Only a manager can change your questionnaires.');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });
const conflict = () => new TprmError(409, 'Someone else changed this questionnaire after you opened it. Reload the page and try again.');
const notFound = () => new TprmError(404, 'This questionnaire does not exist, or it is not available to your account.');

function canEdit(user) {
  return access.isFirmUser(user) && access.firmCan(user, PERMISSION) && !!user.firm_id;
}
function requireEdit(user) {
  if (!canEdit(user)) throw forbidden();
}

const str = v => (v == null ? '' : String(Array.isArray(v) ? v[0] : v)).replace(/\r\n/g, '\n').trim();
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);

async function bankPrefixes(db) {
  const latest = await require('./questionnaires').latestBankVersion(db);
  if (!latest) return new Set();
  const bank = await require('./questionnaires').bankContent(db, latest.id);
  return new Set((bank.questions || []).map(q => String(q.id).split('-')[0]));
}

function prefixFrom(name) {
  const letters = String(name || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  const initials = letters.map(w => w[0]).join('');
  if (initials.length >= 2) return initials.slice(0, 4);
  return (letters[0] || 'QS').slice(0, 3).padEnd(2, 'Q');
}

function rowOf(r) {
  if (!r) return null;
  return { ...r, id: Number(r.id), firm_id: Number(r.firm_id), draft: parse(r.draft), row_version: Number(r.row_version) };
}

async function list(db, firmId) {
  const rows = await db.prepare(`SELECT t.id, t.name, t.description, t.prefix, t.status, t.draft_changed, t.updated_at, t.draft,
      v.version, v.published_at, v.question_count
    FROM tp_q_templates t
    LEFT JOIN LATERAL (SELECT version, published_at, question_count FROM tp_q_template_versions WHERE template_id = t.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE t.firm_id = ? ORDER BY t.status, lower(t.name)`).all(Number(firmId));
  return rows.map(r => {
    const d = parse(r.draft);
    return { id: Number(r.id), name: r.name, description: r.description, prefix: r.prefix, status: r.status, draftChanged: !!r.draft_changed,
      version: r.version ? Number(r.version) : null, publishedAt: r.published_at, questionCount: r.question_count ? Number(r.question_count) : 0,
      draftQuestions: d.questions.length, draftSections: d.sections.length,
      withRules: d.questions.filter(q => q.ai_valid || q.ai_meets || q.ai_partly || q.ai_red_flags).length };
  });
}

async function get(db, firmId, id) {
  const r = await db.prepare('SELECT * FROM tp_q_templates WHERE firm_id = ? AND id = ?').get(Number(firmId), Number(id) || 0);
  if (!r) throw notFound();
  const t = rowOf(r);
  const latest = await db.prepare(`SELECT id, version, published_at, question_count FROM tp_q_template_versions WHERE template_id = ? ORDER BY version DESC LIMIT 1`).get(t.id);
  t.latest = latest ? { id: Number(latest.id), version: Number(latest.version), publishedAt: latest.published_at, questionCount: Number(latest.question_count) } : null;
  return t;
}

async function create(db, user, input = {}) {
  requireEdit(user);
  const errors = [];
  const name = str(input.name);
  const description = str(input.description);
  if (!name) errors.push('Give the questionnaire a name.');
  if (name.length > LIMITS.name) errors.push(`The name must be ${LIMITS.name} characters or fewer.`);
  if (description.length > LIMITS.description) errors.push(`The description must be ${LIMITS.description} characters or fewer.`);
  let prefix = str(input.prefix).toUpperCase() || prefixFrom(name);
  if (!/^[A-Z]{2,5}$/.test(prefix)) errors.push('The question code must be 2 to 5 capital letters, for example BCP.');
  if (errors.length) throw invalid(errors);
  const taken = await bankPrefixes(db);
  const firmTaken = new Set((await db.prepare('SELECT prefix FROM tp_q_templates WHERE firm_id = ?').all(Number(user.firm_id))).map(r => r.prefix));
  if (!str(input.prefix)) {
    let n = 2;
    const base = prefix;
    while (taken.has(prefix) || firmTaken.has(prefix)) prefix = `${base.slice(0, 4)}${String.fromCharCode(64 + n++)}`.slice(0, 5);
  } else if (taken.has(prefix)) {
    throw invalid([`${prefix} is already used by the question bank. Choose another question code.`]);
  } else if (firmTaken.has(prefix)) {
    throw invalid([`${prefix} is already used by another of your questionnaires.`]);
  }
  try {
    const row = await db.prepare(`INSERT INTO tp_q_templates (firm_id, name, description, prefix, draft, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?::jsonb, ?, ?) RETURNING id`).get(Number(user.firm_id), name, description || null, prefix,
      JSON.stringify({ sections: [{ key: 's1', title: 'Section 1' }], questions: [] }), user.id, user.id);
    return Number(row.id);
  } catch (err) {
    if (require('../pg').isUniqueViolation(err)) throw invalid(['You already have a questionnaire with that name.']);
    throw err;
  }
}

async function mutate(db, user, id, input, fn) {
  requireEdit(user);
  return await db.transaction(async () => {
    const r = await db.prepare('SELECT * FROM tp_q_templates WHERE firm_id = ? AND id = ? FOR UPDATE').get(Number(user.firm_id), Number(id) || 0);
    if (!r) throw notFound();
    const t = rowOf(r);
    if (input && input.row_version !== undefined && input.row_version !== '' && Number(input.row_version) !== t.row_version) throw conflict();
    const draft = JSON.parse(JSON.stringify(t.draft));
    const pub = { ids: new Set(draft.retired_ids || []), types: new Map() };
    for (const v of await db.prepare('SELECT content FROM tp_q_template_versions WHERE template_id = ? ORDER BY version').all(t.id)) {
      for (const q of parse(v.content).questions || []) { pub.ids.add(q.id); pub.types.set(q.id, q.answer_type); }
    }
    const result = fn(draft, t, pub);
    if (result && result.unchanged) return result;
    await db.prepare(`UPDATE tp_q_templates SET draft = ?::jsonb, draft_changed = true, updated_by = ?, updated_at = now(), row_version = row_version + 1
      WHERE id = ?`).run(JSON.stringify(draft), user.id, t.id);
    return result === undefined ? { ok: true } : result;
  })();
}

async function updateDetails(db, user, id, input = {}) {
  requireEdit(user);
  const name = str(input.name);
  const description = str(input.description);
  const errors = [];
  if (!name) errors.push('Give the questionnaire a name.');
  if (name.length > LIMITS.name) errors.push(`The name must be ${LIMITS.name} characters or fewer.`);
  if (description.length > LIMITS.description) errors.push(`The description must be ${LIMITS.description} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  try {
    const r = await db.prepare(`UPDATE tp_q_templates SET name = ?, description = ?, updated_by = ?, updated_at = now(), row_version = row_version + 1
      WHERE firm_id = ? AND id = ? RETURNING id`).get(name, description || null, user.id, Number(user.firm_id), Number(id) || 0);
    if (!r) throw notFound();
  } catch (err) {
    if (require('../pg').isUniqueViolation(err)) throw invalid(['You already have a questionnaire with that name.']);
    throw err;
  }
}

async function setStatus(db, user, id, status) {
  requireEdit(user);
  if (!['active', 'archived'].includes(status)) throw invalid(['Unknown status.']);
  const r = await db.prepare(`UPDATE tp_q_templates SET status = ?, updated_by = ?, updated_at = now(), row_version = row_version + 1
    WHERE firm_id = ? AND id = ? RETURNING id`).get(status, user.id, Number(user.firm_id), Number(id) || 0);
  if (!r) throw notFound();
}

function sectionKey(draft) {
  let n = draft.sections.length + 1;
  while (draft.sections.some(s => s.key === `s${n}`)) n += 1;
  return `s${n}`;
}

function sectionTitle(raw, errors) {
  const title = str(raw);
  if (!title) errors.push('Give the section a name.');
  if (title.length > LIMITS.section) errors.push(`A section name must be ${LIMITS.section} characters or fewer.`);
  return title;
}

const addSection = (db, user, id, input) => mutate(db, user, id, input, draft => {
  const errors = [];
  const title = sectionTitle(input.title, errors);
  if (draft.sections.some(s => s.title.toLowerCase() === title.toLowerCase())) errors.push('There is already a section with that name.');
  if (draft.sections.length >= LIMITS.sections) errors.push(`A questionnaire holds at most ${LIMITS.sections} sections.`);
  if (errors.length) throw invalid(errors);
  const key = sectionKey(draft);
  draft.sections.push({ key, title });
  return { key };
});

const renameSection = (db, user, id, key, input) => mutate(db, user, id, input, draft => {
  const s = draft.sections.find(x => x.key === key);
  if (!s) throw invalid(['This section does not exist.']);
  const errors = [];
  const title = sectionTitle(input.title, errors);
  if (draft.sections.some(x => x.key !== key && x.title.toLowerCase() === title.toLowerCase())) errors.push('There is already a section with that name.');
  if (errors.length) throw invalid(errors);
  s.title = title;
});

const moveSection = (db, user, id, key, input) => mutate(db, user, id, input, draft => {
  const at = draft.sections.findIndex(x => x.key === key);
  if (at < 0) throw invalid(['This section does not exist.']);
  const to = at + (input.dir === 'up' ? -1 : 1);
  if (to < 0 || to >= draft.sections.length) return;
  const [s] = draft.sections.splice(at, 1);
  draft.sections.splice(to, 0, s);
});

const removeSection = (db, user, id, key, input) => mutate(db, user, id, input, draft => {
  const at = draft.sections.findIndex(x => x.key === key);
  if (at < 0) throw invalid(['This section does not exist.']);
  if (draft.questions.some(q => q.section === key)) throw invalid(['Move or remove the questions in this section first.']);
  if (draft.sections.length === 1) throw invalid(['A questionnaire keeps at least one section.']);
  draft.sections.splice(at, 1);
});

function cleanRule(input, errors, ctx) {
  const { known, before } = ctx;
  if (str(input.show_mode) !== 'when') return null;
  const qs = [].concat(input.cond_question || []);
  const ops = [].concat(input.cond_op || []);
  const vals = [].concat(input.cond_value || []);
  const conditions = [];
  qs.forEach((qRaw, i) => {
    const question = str(qRaw);
    if (!question) return;
    const op = str(ops[i]);
    if (!assembly.RULE_OPS.includes(op)) { errors.push('Choose how each condition compares.'); return; }
    if (!known.has(question)) { errors.push(`${question} is not a question you can use in a condition here.`); return; }
    if (!before.has(question)) errors.push(`${question} comes after this question. A condition can only use questions asked before it.`);
    const value = str(vals[i]);
    if (!['answered', 'not_answered'].includes(op) && !value) errors.push(`Give the value to compare ${question} with.`);
    const parent = ctx.byId ? ctx.byId.get(question) : null;
    if (parent && value && !['answered', 'not_answered'].includes(op)) {
      const t = parent.answer_type;
      if (['free_text', 'url', 'file'].includes(t)) errors.push(`${question} has no fixed answers, so a rule can only check whether it is answered.`);
      else if (t === 'yes_no_na' && !['is', 'is_not'].includes(op)) errors.push(`${question} is answered Yes, No or Not applicable: use "is" or "is not".`);
      else if (t === 'yes_no_na' && !['yes', 'no', 'na'].includes(value)) errors.push(`For ${question} the value must be yes, no or na.`);
      else if (CHOICE_TYPES.includes(t) && !['is', 'is_not', 'includes'].includes(op)) errors.push(`${question} is a choice question: use "is", "is not" or "includes".`);
      else if (CHOICE_TYPES.includes(t) && !(parent.options || []).includes(value)) errors.push(`"${value}" is not one of the options of ${question}. Use one exactly as written: ${(parent.options || []).join(', ')}.`);
      else if (t === 'number' && !/^-?\d+(?:[.,]\d+)?$/.test(value)) errors.push(`For ${question} the value must be a number.`);
      else if (t === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`For ${question} the value must be a date written YYYY-MM-DD.`);
    }
    if (['more_than', 'less_than'].includes(op) && value && !/^-?\d+(?:[.,]\d+)?$/.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      errors.push(`"${value}" is not a number or a date (YYYY-MM-DD), so ${question} cannot be compared with it.`);
    }
    conditions.push({ question, op, value: ['answered', 'not_answered'].includes(op) ? '' : value.slice(0, LIMITS.option) });
  });
  if (!conditions.length) { errors.push('Add at least one condition, or choose to show the question always.'); return null; }
  if (conditions.length > LIMITS.conditions) errors.push(`At most ${LIMITS.conditions} conditions.`);
  return { mode: str(input.show_join) === 'any' ? 'any' : 'all', conditions };
}

function cleanQuestion(input, errors, ctx = {}) {
  const out = {};
  const type = str(input.answer_type);
  if (!rulesLib.ANSWER_TYPES.includes(type)) errors.push('Choose how the question is answered.');
  out.answer_type = rulesLib.ANSWER_TYPES.includes(type) ? type : 'yes_no_na';
  out.question = str(input.question);
  if (!out.question) errors.push('Write the question.');
  if (out.question.length > LIMITS.question) errors.push(`The question must be ${LIMITS.question} characters or fewer.`);
  out.theme = str(input.theme);
  if (!out.theme) {
    const flat = out.question.replace(/\s+/g, ' ');
    out.theme = flat.length <= 70 ? flat.replace(/[?.:]$/, '') : `${flat.slice(0, 70).replace(/\s\S*$/, '')}...`;
    out.theme_auto = true;
  }
  if (out.theme.length > LIMITS.theme) errors.push(`The short title must be ${LIMITS.theme} characters or fewer.`);
  out.guidance = str(input.guidance);
  if (out.guidance.length > LIMITS.guidance) errors.push(`The guidance must be ${LIMITS.guidance} characters or fewer.`);
  out.required = str(input.required) === '1';
  const settings = require('./question-settings').answerSettings(out.answer_type, { ...input, settings_shown: '1' }, errors);
  for (const [k, v] of Object.entries(settings)) if (v !== null && v !== undefined && v !== false && !(k === 'evidence' && !v)) out[k] = v;
  if (out.answer_type === 'yes_no_na') out.explain_on = settings.explain_on;
  if (out.answer_type === 'yes_no_na' || out.answer_type === 'free_text') out.evidence_on = settings.evidence_on;
  if (settings.evidence_mandatory === false) delete out.evidence_mandatory;
  out.benchmark = str(input.benchmark);
  if (out.benchmark.length > 1000) errors.push('The benchmark must be 1000 characters or fewer.');
  out.show_when = cleanRule(input, errors, ctx);
  if (!out.show_when) delete out.show_when;
  for (const k of ['ai_valid', 'ai_meets', 'ai_partly', 'ai_red_flags']) {
    out[k] = str(input[k]);
    if (out[k].length > LIMITS.ai) errors.push(`Each marking rule must be ${LIMITS.ai} characters or fewer.`);
  }
  for (const k of ['guidance', 'evidence', 'ai_valid', 'ai_meets', 'ai_partly', 'ai_red_flags', 'benchmark']) if (!out[k]) delete out[k];
  return out;
}

function ordered(draft) {
  const out = [];
  for (const s of draft.sections) for (const q of draft.questions) if (q.section === s.key) out.push(q);
  return out;
}

function nextId(draft, prefix, used = new Set()) {
  const nums = [...draft.questions.map(q => q.id), ...used].map(id => Number(String(id).split('-')[1]) || 0);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(n).padStart(2, '0')}`;
}

function addTo(draft, t, pub, input, errors) {
  const section = str(input.section);
  if (!draft.sections.some(s => s.key === section)) { errors.push('Choose the section for the question.'); return null; }
  if (draft.questions.length >= LIMITS.questions) { errors.push(`A questionnaire holds at most ${LIMITS.questions} questions.`); return null; }
  const before = errors.length;
  const all = ordered(draft);
  const lastOfSection = all.filter(q => q.section === section).pop();
  const cut = lastOfSection ? all.indexOf(lastOfSection) + 1 : all.findIndex(q => draft.sections.findIndex(s => s.key === q.section) > draft.sections.findIndex(s => s.key === section));
  const earlier = new Set((cut < 0 ? all : all.slice(0, cut)).map(q => q.id));
  const v = cleanQuestion(input, errors, { known: new Set(all.map(q => q.id)), before: earlier, byId: new Map(all.map(q => [q.id, q])) });
  if (errors.length > before) return null;
  const qid = nextId(draft, t.prefix, pub.ids);
  draft.questions.push({ id: qid, section, ...v });
  return qid;
}

const stable = v => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));

function saveIn(draft, pub, qid, input, errors) {
  const q = draft.questions.find(x => x.id === qid);
  if (!q) { errors.push('This question does not exist.'); return false; }
  const start = errors.length;
  const all = ordered(draft);
  const earlier = new Set(all.slice(0, all.indexOf(q)).map(x => x.id));
  const section = str(input.section) || q.section;
  if (!draft.sections.some(s => s.key === section)) errors.push('Choose the section for the question.');
  const v = cleanQuestion(input, errors, { known: new Set(all.map(x => x.id).filter(x => x !== qid)), before: earlier, byId: new Map(all.map(x => [x.id, x])) });
  if (pub.types.has(qid) && pub.types.get(qid) !== v.answer_type) {
    errors.push(`${qid} is published, so how it is answered cannot change: answers already given keep their meaning. Remove it and add a new question instead.`);
  }
  const dependants = draft.questions.filter(x => x.show_when && x.show_when.conditions.some(c => c.question === qid));
  if (CHOICE_TYPES.includes(v.answer_type)) {
    const gone = dependants.flatMap(x => x.show_when.conditions.filter(c => c.question === qid && c.value && !(v.options || []).includes(c.value)).map(c => `${x.id} (${c.value})`));
    if (gone.length) errors.push(`A rule uses an option you removed or renamed: ${gone.join(', ')}. Change ${gone.length === 1 ? 'that rule' : 'those rules'} first.`);
  }
  if (dependants.length && q.answer_type !== v.answer_type) {
    errors.push(`${dependants.map(x => x.id).join(', ')} ${dependants.length === 1 ? 'is' : 'are'} shown depending on this answer, so its answer type cannot change. Change ${dependants.length === 1 ? 'that rule' : 'those rules'} first.`);
  }
  if (errors.length > start) return false;
  const was = stable(q);
  for (const k of Object.keys(q)) if (!['id', 'section'].includes(k)) delete q[k];
  Object.assign(q, v, { section });
  return stable(q) !== was;
}

function removeFrom(draft, qid, errors) {
  const at = draft.questions.findIndex(x => x.id === qid);
  if (at < 0) { errors.push('This question does not exist.'); return; }
  const dependants = draft.questions.filter(x => x.show_when && x.show_when.conditions.some(c => c.question === qid));
  if (dependants.length) { errors.push(`${dependants.map(x => x.id).join(', ')} ${dependants.length === 1 ? 'is' : 'are'} shown depending on this answer. Change ${dependants.length === 1 ? 'that rule' : 'those rules'} first.`); return; }
  draft.retired_ids = [...new Set([...(draft.retired_ids || []), draft.questions[at].id])];
  draft.questions.splice(at, 1);
}

const failIf = errors => { if (errors.length) throw invalid(errors); };

const addQuestion = (db, user, id, input) => mutate(db, user, id, input, (draft, t, pub) => {
  const errors = [];
  const qid = addTo(draft, t, pub, input, errors);
  failIf(errors);
  return { id: qid };
});

const saveQuestion = (db, user, id, qid, input) => mutate(db, user, id, input, (draft, t, pub) => {
  const errors = [];
  saveIn(draft, pub, qid, input, errors);
  failIf(errors);
});

const removeQuestion = (db, user, id, qid, input) => mutate(db, user, id, input, draft => {
  const errors = [];
  removeFrom(draft, qid, errors);
  failIf(errors);
});

const importRows = (db, user, id, rows, input = {}) => mutate(db, user, id, input, (draft, t, pub) => {
  const errors = [];
  const out = { added: 0, changed: 0, removed: 0, sections: 0 };
  const keyOf = title => (draft.sections.find(s => s.title.toLowerCase() === String(title || '').trim().toLowerCase()) || {}).key;
  const sheet = require('./question-sheet');
  const questionOf = qid => draft.questions.find(x => x.id === String(qid || '').toUpperCase());
  for (const row of rows) {
    if (row.remove) continue;
    const where = row.id || `Row ${row.row}`;
    const rowErrors = [];
    let key = row.section ? keyOf(row.section) : null;
    if (row.section && !key) {
      const title = sectionTitle(row.section, rowErrors);
      if (draft.sections.length >= LIMITS.sections) rowErrors.push(`A questionnaire holds at most ${LIMITS.sections} sections.`);
      if (!rowErrors.length) {
        key = sectionKey(draft);
        draft.sections.push({ key, title });
        out.sections += 1;
      }
    }
    const fields = sheet.fixRuleValues({ ...row.input }, questionOf);
    if (!rowErrors.length) {
      if (row.id) {
        if (!draft.questions.some(x => x.id === row.id)) rowErrors.push('not in this questionnaire. Leave the number empty to add a new question.');
        else if (saveIn(draft, pub, row.id, { ...fields, section: key || '' }, rowErrors)) out.changed += 1;
      } else if (!key) {
        rowErrors.push('write the section the new question goes in.');
      } else if (addTo(draft, t, pub, { ...fields, section: key }, rowErrors)) {
        out.added += 1;
      }
    }
    errors.push(...rowErrors.map(e => `${where}: ${e}`));
  }
  for (const row of rows) {
    if (!row.remove) continue;
    const rowErrors = [];
    if (!draft.questions.some(x => x.id === row.id)) rowErrors.push('not in this questionnaire.');
    else { removeFrom(draft, row.id, rowErrors); if (!rowErrors.length) out.removed += 1; }
    errors.push(...rowErrors.map(e => `${row.id}: ${e}`));
  }
  if (!errors.length) {
    const all = ordered(draft);
    const pos = new Map(all.map((x, n) => [x.id, n]));
    for (const q of all) for (const c of (q.show_when ? q.show_when.conditions : [])) if (pos.get(c.question) > pos.get(q.id)) errors.push(`${q.id}: its rule uses ${c.question}, which comes after it.`);
  }
  if (errors.length) throw invalid([...new Set(errors)].slice(0, 20));
  if (!out.added && !out.changed && !out.removed && !out.sections) out.unchanged = true;
  return out;
});

const moveQuestion = (db, user, id, qid, input) => mutate(db, user, id, input, draft => {
  const q = draft.questions.find(x => x.id === qid);
  if (!q) throw invalid(['This question does not exist.']);
  const same = draft.questions.filter(x => x.section === q.section);
  const at = same.indexOf(q);
  const to = at + (input.dir === 'up' ? -1 : 1);
  if (to < 0 || to >= same.length) return;
  const other = same[to];
  const i = draft.questions.indexOf(q);
  const j = draft.questions.indexOf(other);
  draft.questions[i] = other;
  draft.questions[j] = q;
  const all = ordered(draft);
  const pos = new Map(all.map((x, n) => [x.id, n]));
  const broken = all.filter(x => x.show_when && x.show_when.conditions.some(c => pos.get(c.question) > pos.get(x.id)));
  if (broken.length) throw invalid([`${broken[0].id} would then come before a question its rule depends on. Move that question too, or change the rule.`]);
});

function ruleOrderProblems(draft) {
  const all = ordered(draft);
  const pos = new Map(all.map((x, n) => [x.id, n]));
  const broken = all.find(x => x.show_when && x.show_when.conditions.some(c => pos.get(c.question) > pos.get(x.id)));
  if (!broken) return [];
  const parent = broken.show_when.conditions.find(c => pos.get(c.question) > pos.get(broken.id)).question;
  return [`${broken.id} would then come before ${parent}, which its rule depends on. Move ${parent} too, or change the rule.`];
}

const idList = v => [...new Set([].concat(v || []).map(x => str(x).toUpperCase()).filter(Boolean))];

const reorderQuestions = (db, user, id, input) => mutate(db, user, id, input, draft => {
  const section = str(input.section);
  if (!draft.sections.some(s => s.key === section)) throw invalid(['This section does not exist.']);
  const inSection = draft.questions.filter(q => q.section === section);
  const order = idList(input.order);
  if (order.length !== inSection.length || inSection.some(q => !order.includes(q.id))) throw invalid(['The page was out of date. Reload it and try again.']);
  const slots = draft.questions.map((q, i) => (q.section === section ? i : -1)).filter(i => i >= 0);
  const byId = new Map(inSection.map(q => [q.id, q]));
  order.forEach((qid, n) => { draft.questions[slots[n]] = byId.get(qid); });
  const errors = ruleOrderProblems(draft);
  if (errors.length) throw invalid(errors);
});

const reorderSections = (db, user, id, input) => mutate(db, user, id, input, draft => {
  const order = [...new Set([].concat(input.order || []).map(str).filter(Boolean))];
  if (order.length !== draft.sections.length || draft.sections.some(s => !order.includes(s.key))) throw invalid(['The page was out of date. Reload it and try again.']);
  const byKey = new Map(draft.sections.map(s => [s.key, s]));
  draft.sections = order.map(k => byKey.get(k));
  const errors = ruleOrderProblems(draft);
  if (errors.length) throw invalid(errors);
});

const BULK = Object.freeze(['required', 'optional', 'move', 'remove']);

const bulkQuestions = (db, user, id, input) => mutate(db, user, id, input, draft => {
  const action = str(input.bulk);
  if (!BULK.includes(action)) throw invalid(['Choose what to do with the ticked questions.']);
  const ids = idList(input.ids);
  if (!ids.length) throw invalid(['Tick at least one question first.']);
  const picked = draft.questions.filter(q => ids.includes(q.id));
  if (picked.length !== ids.length) throw invalid(['The page was out of date. Reload it and try again.']);
  if (action === 'required' || action === 'optional') {
    for (const q of picked) q.required = action === 'required';
    return { action, count: picked.length };
  }
  if (action === 'move') {
    const to = str(input.to_section);
    if (!draft.sections.some(s => s.key === to)) throw invalid(['Choose the section to move them to.']);
    const rest = draft.questions.filter(q => !ids.includes(q.id));
    for (const q of picked) q.section = to;
    draft.questions = [...rest, ...picked];
    const errors = ruleOrderProblems(draft);
    if (errors.length) throw invalid(errors);
    return { action, count: picked.length, section: to };
  }
  const blocked = draft.questions.filter(x => !ids.includes(x.id) && x.show_when && x.show_when.conditions.some(c => ids.includes(c.question)));
  if (blocked.length) throw invalid([`${blocked.map(x => x.id).join(', ')} ${blocked.length === 1 ? 'is' : 'are'} shown depending on a question you ticked. Tick ${blocked.length === 1 ? 'it' : 'them'} too, or change ${blocked.length === 1 ? 'that rule' : 'those rules'} first.`]);
  draft.retired_ids = [...new Set([...(draft.retired_ids || []), ...ids])];
  draft.questions = draft.questions.filter(q => !ids.includes(q.id));
  return { action, count: picked.length };
});

function problems(draft) {
  const errors = [];
  if (!draft.questions.length) errors.push('Add at least one question before publishing.');
  const all = ordered(draft);
  if (all.length !== draft.questions.length) errors.push('Some questions are in a section that no longer exists.');
  const pos = new Map(all.map((x, n) => [x.id, n]));
  for (const q of all) {
    for (const c of (q.show_when ? q.show_when.conditions : [])) {
      if (!pos.has(c.question)) errors.push(`${q.id}: its rule uses ${c.question}, which is no longer in the questionnaire.`);
      else if (pos.get(c.question) > pos.get(q.id)) errors.push(`${q.id}: its rule uses ${c.question}, which comes after it.`);
    }
    if (CHOICE_TYPES.includes(q.answer_type) && (!q.options || q.options.length < 2)) errors.push(`${q.id}: a choice question needs at least two options.`);
  }
  for (const s of draft.sections) if (!draft.questions.some(q => q.section === s.key)) errors.push(`The section "${s.title}" has no questions: add some or remove it.`);
  return errors;
}

async function publish(db, user, id, input = {}) {
  requireEdit(user);
  return await db.transaction(async () => {
    const r = await db.prepare('SELECT * FROM tp_q_templates WHERE firm_id = ? AND id = ? FOR UPDATE').get(Number(user.firm_id), Number(id) || 0);
    if (!r) throw notFound();
    const t = rowOf(r);
    if (input.row_version !== undefined && input.row_version !== '' && Number(input.row_version) !== t.row_version) throw conflict();
    const errors = problems(t.draft);
    if (errors.length) throw invalid(errors);
    const last = await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM tp_q_template_versions WHERE template_id = ?').get(t.id);
    const content = { sections: t.draft.sections, questions: ordered(t.draft) };
    if (Number(last.v)) {
      const prev = await db.prepare('SELECT content FROM tp_q_template_versions WHERE template_id = ? AND version = ?').get(t.id, Number(last.v));
      if (!require('./q-template-history').compare(parse(prev.content), content).count) throw invalid([`Nothing has changed since version ${Number(last.v)}.`]);
    }
    const version = Number(last.v) + 1;
    const note = str(input.note).slice(0, 300) || null;
    await db.prepare(`INSERT INTO tp_q_template_versions (template_id, firm_id, version, content, question_count, published_by, note)
      VALUES (?, ?, ?, ?::jsonb, ?, ?, ?)`).run(t.id, t.firm_id, version, JSON.stringify(content), content.questions.length, user.id, note);
    await db.prepare(`UPDATE tp_q_templates SET draft_changed = false, updated_by = ?, updated_at = now(), row_version = row_version + 1 WHERE id = ?`).run(user.id, t.id);
    return { version };
  })();
}

async function discardDraft(db, user, id, input = {}) {
  requireEdit(user);
  return await db.transaction(async () => {
    const t = await get(db, user.firm_id, id);
    if (!t.latest) throw invalid(['Nothing is published yet, so there is no earlier version to go back to.']);
    if (input.row_version !== undefined && input.row_version !== '' && Number(input.row_version) !== t.row_version) throw conflict();
    const v = await db.prepare('SELECT content FROM tp_q_template_versions WHERE id = ?').get(t.latest.id);
    await db.prepare(`UPDATE tp_q_templates SET draft = ?::jsonb, draft_changed = false, updated_by = ?, updated_at = now(), row_version = row_version + 1 WHERE id = ?`)
      .run(JSON.stringify(parse(v.content)), user.id, t.id);
  })();
}

async function restoreVersion(db, user, id, version, input = {}) {
  const v = await db.prepare(`SELECT v.content FROM tp_q_template_versions v JOIN tp_q_templates t ON t.id = v.template_id
    WHERE t.firm_id = ? AND v.template_id = ? AND v.version = ?`).get(Number(user.firm_id), Number(id) || 0, Number(version) || 0);
  if (!v) throw new TprmError(404, 'This version does not exist.');
  return await mutate(db, user, id, input, draft => {
    const content = parse(v.content);
    const keep = new Set(content.questions.map(q => q.id));
    draft.retired_ids = [...new Set([...(draft.retired_ids || []), ...draft.questions.map(q => q.id).filter(x => !keep.has(x))])];
    draft.sections = content.sections;
    draft.questions = content.questions;
    return { version: Number(version) };
  });
}

async function publishedIds(db, templateId) {
  const ids = new Set();
  for (const v of await db.prepare('SELECT content FROM tp_q_template_versions WHERE template_id = ?').all(Number(templateId))) {
    for (const q of parse(v.content).questions || []) ids.add(q.id);
  }
  return [...ids];
}

async function published(db, firmId) {
  const rows = await db.prepare(`SELECT t.id, t.name, t.description, v.id AS version_id, v.version, v.question_count
    FROM tp_q_templates t JOIN LATERAL (SELECT id, version, question_count FROM tp_q_template_versions WHERE template_id = t.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE t.firm_id = ? AND t.status = 'active' ORDER BY lower(t.name)`).all(Number(firmId));
  return rows.map(r => ({ id: Number(r.id), name: r.name, description: r.description, versionId: Number(r.version_id), version: Number(r.version), questionCount: Number(r.question_count) }));
}

function rowsOf(content, name) {
  const titles = new Map(content.sections.map(s => [s.key, s.title]));
  return content.questions.map(q => {
    const row = { ...q, set: SET_NAME, pack: name, domain: titles.get(q.section) || '', section_key: q.section, answered_by: 'Vendor', delivery_models: '',
      min_tier: 'All tiers', report_coverage: 'none', status: 'Firm questionnaire', source: name };
    delete row.section;
    return row;
  });
}

async function forQuestionnaire(db, firmId, templateId, mode) {
  if (!['instead', 'with'].includes(mode)) throw invalid(['Choose which questionnaire to send.']);
  const t = await db.prepare(`SELECT t.id, t.name, v.id AS version_id, v.version, v.content FROM tp_q_templates t
    JOIN LATERAL (SELECT id, version, content FROM tp_q_template_versions WHERE template_id = t.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE t.firm_id = ? AND t.id = ? AND t.status = 'active'`).get(Number(firmId), Number(templateId) || 0);
  if (!t) throw invalid(['Choose one of your published questionnaires.']);
  const content = parse(t.content);
  return {
    meta: { template_id: Number(t.id), version_id: Number(t.version_id), version: Number(t.version), name: t.name, mode, sections: content.sections.map(s => ({ key: s.key, title: s.title })) },
    rows: rowsOf(content, t.name),
  };
}

function sectionsFor(meta, rows) {
  if (!meta || !Array.isArray(rows) || !rows.length) return [];
  const sections = (meta.sections || []).map(s => ({ kind: 'template', title: s.title, key: s.key, ids: [] }));
  const follow = [];
  const optional = new Set();
  for (const row of rows) {
    if (assembly.showWhen(row)) { follow.push(row); continue; }
    const s = sections.find(x => x.key === row.section_key);
    if (!s) continue;
    s.ids.push(row.id);
    if (row.required === false) optional.add(row.id);
  }
  assembly.placeFollowups(sections, follow);
  assembly.markOptional(sections, optional);
  return sections.filter(s => s.ids.length).map(s => { const out = { ...s }; delete out.key; return out; });
}

module.exports = { publishedIds,
  PERMISSION, SET_NAME, MODES, MODE_LABELS, LIMITS, CHOICE_TYPES, canEdit, list, get, create, updateDetails, setStatus,
  addSection, renameSection, moveSection, removeSection, addQuestion, saveQuestion, removeQuestion, moveQuestion, importRows, reorderQuestions, reorderSections, bulkQuestions, BULK,
  problems, publish, discardDraft, restoreVersion, published, forQuestionnaire, sectionsFor, cleanQuestion, ordered, rowsOf,
};
