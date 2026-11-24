'use strict';

const crypto = require('crypto');
const access = require('./access');
const { TprmError } = require('./errors');

const PERMISSION = 'tp.settings';
const ID = /^[A-Z]{2,6}-[0-9]{1,4}$/;
const TIERS = Object.freeze(['All tiers', 'Low', 'Medium', 'High', 'Critical']);
const EDITABLE = Object.freeze(['theme', 'question', 'guidance', 'evidence', 'evidence_mandatory', 'min_tier', 'benchmark', 'iso27001']);
const LIMITS = Object.freeze({ theme: 120, question: 1500, guidance: 2000, evidence: 400, benchmark: 1000, iso27001: 120 });
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
    const fields = EDITABLE.filter(k => !same(o[k], q[k]));
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
    if (same(q[k], v[k])) continue;
    q[k] = v[k];
  }
}

function editedValues(input, errors) {
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
    const v = editedValues(input, errors);
    if (errors.length) throw invalid(errors);
    applyValues(q, v);
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
  return await mutate(db, user, input, content => {
    const like = (content.questions || []).find(x => x.id === String(input.like || ''));
    if (!like) throw invalid(['Choose an existing question to place the new one beside.']);
    if (like.set === RULEBOOK_SET) throw invalid(['Questions for a rulebook are chosen by the rulebook itself, so add new questions to the base set or a module.']);
    const errors = [];
    const v = editedValues(input, errors);
    if (errors.length) throw invalid(errors);
    const id = nextId(content, like.id.split('-')[0]);
    const q = { id };
    for (const k of COPIED) if (like[k] !== undefined) q[k] = like[k];
    if (q.answer_type !== 'yes_no_na' && q.answer_type !== 'free_text') q.answer_type = 'yes_no_na';
    q.report_coverage = 'none';
    Object.assign(q, v, { status: 'Added in the tool', change_note: '', source: 'Added on the question bank page' });
    const at = content.questions.indexOf(like);
    content.questions.splice(at + 1, 0, q);
    return { id };
  });
}

async function retireQuestion(db, user, id, input = {}) {
  return await mutate(db, user, input, content => {
    const target = (content.questions || []).find(x => x.id === id);
    if (target && target.set === RULEBOOK_SET) throw new TprmError(409, `${id} belongs to a rulebook, which lists its own questions, so it cannot be retired here.`);
    if (protectedIds(content).has(id)) throw new TprmError(409, `${id} is used by the tool itself (reports, data location, subprocessors or modules), so it cannot be retired.`);
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
  if (!(await draftRow(db))) await startDraft(db, user);
  return await mutate(db, user, {}, content => {
    const byId = new Map((content.questions || []).map(q => [q.id, q]));
    const keep = protectedIds(content);
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
      const v = editedValues(row.values, rowErrors);
      errors.push(...rowErrors.map(e => `${row.id}: ${e}`));
      if (!rowErrors.length) plan.push({ q, v });
    }
    if (errors.length) throw invalid(errors.slice(0, 20));
    let changed = 0;
    let retired = 0;
    for (const p of plan) {
      if (p.retire) {
        content.questions = content.questions.filter(x => x.id !== p.retire);
        content.retired_ids = [...new Set([...(content.retired_ids || []), p.retire])];
        retired += 1;
      } else if (EDITABLE.some(k => !same(p.q[k], p.v[k]))) {
        applyValues(p.q, p.v);
        changed += 1;
      }
    }
    return { changed, retired, rows: rows.length };
  });
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

module.exports = {
  PERMISSION, TIERS, EDITABLE, LIMITS, CODE_IDS,
  RULEBOOK_SET, protectedIds, latest, importRows, history, inUse, everUsedIds, draftRow, diff, state, startDraft, discard, updateQuestion, addQuestion, retireQuestion, restoreQuestion, validate, publish, nextId,
};
