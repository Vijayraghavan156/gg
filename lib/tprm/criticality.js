'use strict';

const crypto = require('crypto');
const access = require('./access');

const TIERS = Object.freeze(['Low', 'Medium', 'High', 'Critical']);
const TIER_RANK = Object.freeze({ Low: 1, Medium: 2, High: 3, Critical: 4 });
const TIER_KEYS = Object.freeze(['critical', 'high', 'medium', 'low']);
const LABEL_BY_KEY = Object.freeze({ critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' });
const KINDS = Object.freeze(['criticality', 'service_description']);
const STATUSES = Object.freeze(['draft', 'active', 'retired']);
const DEFAULT_INTERVALS = Object.freeze({ Critical: 12, High: 12, Medium: 24, Low: 36 });
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 120;
const LIMITS = Object.freeze({ questions: 25, answers: 10, text: 300, label: 200 });
const ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const SETTINGS_PERMISSION = 'tp.settings';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const q = (id, kind, text, answers) => ({ id, kind, text, answers: answers.map(([aid, label, tier]) => ({ id: aid, label, tier })) });

const STARTER_QUESTIONS = deepFreeze([
  q('data_handled', 'criticality', 'What data will the third party handle?', [
    ['none', 'None', 'Low'],
    ['internal', 'Internal', 'Medium'],
    ['confidential', 'Confidential business data', 'High'],
    ['personal', 'Personal data', 'High'],
    ['special_financial', 'Special-category, financial or payment data', 'Critical'],
  ]),
  q('service_stops', 'criticality', 'What happens to the client if the service stops?', [
    ['minor', 'Minor inconvenience', 'Low'],
    ['slows', 'A process slows down', 'Medium'],
    ['key_process_stops', 'A key process stops', 'Critical'],
  ]),
  q('system_access', 'criticality', "What access will it have to the client's systems?", [
    ['none', 'None', 'Low'],
    ['user', 'User-level', 'Medium'],
    ['privileged', 'Privileged, admin or network-connected', 'High'],
  ]),
  q('regulated', 'criticality', 'Is the service subject to regulation (e.g. RBI, SEBI, IRDAI, DPDP, GDPR)?', [
    ['no', 'No', 'Low'],
    ['yes', 'Yes', 'High'],
  ]),
  q('replaceability', 'criticality', 'How easily could the client replace it?', [
    ['easily', 'Easily', 'Low'],
    ['with_effort', 'With effort', 'Medium'],
    ['sole_source', 'Sole source', 'High'],
  ]),
  q('delivery_model', 'service_description', 'How is the service delivered?', [
    ['vendor_hosted', 'Hosted or managed by the third party', 'Low'],
    ['installed', "Software installed in the client's environment", 'Low'],
    ['non_technology', 'Non-technology service', 'Low'],
    ['staff_onsite', "Third-party staff work inside the client's environment", 'Low'],
  ]),
  q('payments_records', 'service_description', 'Can the service create or change payments, trades, holdings or client-asset records?', [
    ['no', 'No', 'Low'],
    ['yes', 'Yes', 'Low'],
  ]),
  q('sites_data', 'service_description', "Will the third party's staff work at client sites, or will it hold client data at its own sites?", [
    ['no', 'No', 'Low'],
    ['yes', 'Yes', 'Low'],
  ]),
  q('supplies_software', 'service_description', 'Does the third party supply software or APIs that the client uses?', [
    ['no', 'No', 'Low'],
    ['yes', 'Yes', 'Low'],
  ]),
]);

class CriticalityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CriticalityError';
    this.code = code;
    Object.assign(this, details);
  }
}

const clone = value => JSON.parse(JSON.stringify(value));
const isTier = tier => Object.prototype.hasOwnProperty.call(TIER_RANK, tier);
const tierKey = tier => String(tier).toLowerCase();

function toTierKey(tier) {
  const key = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(LABEL_BY_KEY, key) ? key : null;
}

function tierLabel(tier) {
  const key = toTierKey(tier);
  return key ? LABEL_BY_KEY[key] : null;
}

function validInterval(value) {
  return Number.isInteger(value) && value >= INTERVAL_MIN && value <= INTERVAL_MAX;
}

function validateModel(model) {
  const errors = [];
  const questions = model && model.questions;
  if (!Array.isArray(questions) || !questions.length) {
    return ['Add at least one question.'];
  }
  if (questions.length > LIMITS.questions) errors.push(`A model can have at most ${LIMITS.questions} questions.`);
  const questionIds = new Set();
  let criticalityCount = 0;
  questions.forEach((question, i) => {
    const where = `Question ${i + 1}`;
    if (!question || typeof question !== 'object') { errors.push(`${where} is not a question.`); return; }
    if (typeof question.id !== 'string' || !ID_PATTERN.test(question.id)) errors.push(`${where} has an invalid id.`);
    else if (questionIds.has(question.id)) errors.push(`${where} repeats the id "${question.id}"; question ids must be unique.`);
    else questionIds.add(question.id);
    if (!KINDS.includes(question.kind)) errors.push(`${where} must be a criticality or a service-description question.`);
    if (question.kind === 'criticality') criticalityCount += 1;
    const text = typeof question.text === 'string' ? question.text.trim() : '';
    if (!text) errors.push(`${where} needs its question text.`);
    else if (text.length > LIMITS.text) errors.push(`${where} text is longer than ${LIMITS.text} characters.`);
    const answers = question.answers;
    if (!Array.isArray(answers) || answers.length < 2) { errors.push(`${where} needs at least two answers.`); return; }
    if (answers.length > LIMITS.answers) errors.push(`${where} can have at most ${LIMITS.answers} answers.`);
    const answerIds = new Set();
    answers.forEach((answer, j) => {
      const at = `${where}, answer ${j + 1}`;
      if (!answer || typeof answer !== 'object') { errors.push(`${at} is not an answer.`); return; }
      if (typeof answer.id !== 'string' || !ID_PATTERN.test(answer.id)) errors.push(`${at} has an invalid id.`);
      else if (answerIds.has(answer.id)) errors.push(`${at} repeats the id "${answer.id}"; answer ids must be unique within a question.`);
      else answerIds.add(answer.id);
      const label = typeof answer.label === 'string' ? answer.label.trim() : '';
      if (!label) errors.push(`${at} needs its wording.`);
      else if (label.length > LIMITS.label) errors.push(`${at} is longer than ${LIMITS.label} characters.`);
      if (!isTier(answer.tier)) errors.push(`${at} needs a tier (Low, Medium, High or Critical).`);
      else if (question.kind === 'service_description' && answer.tier !== 'Low') {
        errors.push(`${at}: service-description answers are always Low, so they never raise a tier.`);
      }
    });
  });
  if (!criticalityCount) errors.push('Keep at least one criticality question; service-description questions do not set a tier.');
  const intervals = model.intervals || {};
  for (const tier of [...TIERS].reverse()) {
    if (!validInterval(intervals[tier])) {
      errors.push(`The ${tier} reassessment interval must be a whole number of months from ${INTERVAL_MIN} to ${INTERVAL_MAX}.`);
    }
  }
  return errors;
}

function answerOf(answers, questionId) {
  if (!answers) return undefined;
  const value = answers instanceof Map ? answers.get(questionId) : answers[questionId];
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

function scoreTier(model, answers) {
  const questions = model && Array.isArray(model.questions) ? model.questions : null;
  if (!questions) throw new CriticalityError('invalid', 'The criticality model has no questions.');
  const scored = questions.filter(question => question && question.kind === 'criticality');
  if (!scored.length) throw new CriticalityError('invalid', 'The criticality model has no criticality question.');
  const missing = [];
  let best = null;
  for (const question of scored) {
    const answerId = answerOf(answers, question.id);
    if (answerId === undefined) { missing.push(question.id); continue; }
    const answer = (question.answers || []).find(a => a && a.id === answerId);
    if (!answer) {
      throw new CriticalityError('unknown_answer', `"${answerId}" is not an answer to "${question.text}".`,
        { questionId: question.id, answerId });
    }
    if (!isTier(answer.tier)) {
      throw new CriticalityError('bad_tier', `The answer "${answer.label}" has no tier.`, { questionId: question.id, answerId });
    }
    if (!best || TIER_RANK[answer.tier] > TIER_RANK[best.answer.tier]) best = { question, answer };
  }
  if (missing.length) {
    throw new CriticalityError('unanswered', `Answer every criticality question before the tier can be set (${missing.length} unanswered).`,
      { missing });
  }
  return {
    tier: toTierKey(best.answer.tier),
    tierLabel: best.answer.tier,
    decidingQuestion: { id: best.question.id, text: best.question.text },
    decidingAnswer: { id: best.answer.id, label: best.answer.label, tier: toTierKey(best.answer.tier) },
    explanation: `${best.answer.tier} because: ${best.answer.label}`,
  };
}

function intervalFor(model, tier, clientOverrides = null) {
  const key = toTierKey(tier);
  if (!key) throw new CriticalityError('bad_tier', `"${tier}" is not a tier.`);
  const label = LABEL_BY_KEY[key];
  if (clientOverrides) {
    for (const name of [`interval_months_${key}`, key, label]) {
      const value = clientOverrides[name];
      if (value !== undefined && value !== null && value !== '' && validInterval(Number(value))) return Number(value);
    }
  }
  const intervals = (model && model.intervals) || DEFAULT_INTERVALS;
  return validInterval(intervals[label]) ? intervals[label] : DEFAULT_INTERVALS[label];
}

function intervalsFor(model, clientOverrides = null) {
  return Object.fromEntries(TIER_KEYS.map(key => [key, intervalFor(model, key, clientOverrides)]));
}

async function firmIntervals(db, firmId, { logger = console } = {}) {
  const model = firmId ? await getActiveModel(db, firmId) : null;
  if (!model) {
    if (logger && logger.warn) logger.warn(`[tprm] firm ${firmId} has no active criticality model; using the starter intervals`);
    return { intervals: intervalsFor(null), version: null, fallback: true };
  }
  return { intervals: intervalsFor(model), version: model.version, fallback: false };
}

function indexedList(value, cap) {
  if (Array.isArray(value)) return value.slice(0, cap);
  if (value && typeof value === 'object') {
    return Object.keys(value).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)).slice(0, cap).map(k => value[k]);
  }
  return [];
}

const str = value => (typeof value === 'string' ? value : Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value));

function parseInterval(value) {
  const text = str(value).trim();
  return /^\d{1,4}$/.test(text) ? Number(text) : text === '' ? null : NaN;
}

function modelFromForm(body = {}) {
  const questions = indexedList(body.questions, LIMITS.questions + 1).map(raw => {
    const question = raw && typeof raw === 'object' ? raw : {};
    const kind = KINDS.includes(str(question.kind)) ? str(question.kind) : 'criticality';
    return {
      id: str(question.id).trim(),
      kind,
      text: str(question.text).trim(),
      answers: indexedList(question.answers, LIMITS.answers + 1).map(rawAnswer => {
        const answer = rawAnswer && typeof rawAnswer === 'object' ? rawAnswer : {};
        return {
          id: str(answer.id).trim(),
          label: str(answer.label).trim(),
          tier: kind === 'service_description' ? 'Low' : str(answer.tier),
        };
      }),
    };
  });
  const intervals = {};
  for (const tier of TIERS) intervals[tier] = parseInterval(body[`interval_${tierKey(tier)}`]);
  return { questions, intervals };
}

function newId(prefix, taken) {
  for (;;) {
    const id = `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
}

function applyEdit(model, op) {
  const next = clone(model);
  const qs = next.questions;
  const [name, a, b] = String(op || '').split(':');
  const i = Number(a);
  const j = Number(b);
  const hasQuestion = Number.isInteger(i) && i >= 0 && i < qs.length;
  const refuse = error => ({ model, error });
  switch (name) {
    case 'add_question': {
      if (qs.length >= LIMITS.questions) return refuse(`A model can have at most ${LIMITS.questions} questions.`);
      const question = {
        id: newId('q', new Set(qs.map(x => x.id))),
        kind: 'criticality',
        text: 'New question',
        answers: [],
      };
      const taken = new Set();
      for (const label of ['Answer 1', 'Answer 2']) {
        const id = newId('a', taken);
        taken.add(id);
        question.answers.push({ id, label, tier: 'Low' });
      }
      qs.push(question);
      return { model: next, focus: qs.length - 1 };
    }
    case 'delete_question': {
      if (!hasQuestion) return refuse('That question no longer exists.');
      const remainingCriticality = qs.filter((x, k) => k !== i && x.kind === 'criticality').length;
      if (!remainingCriticality) return refuse('Keep at least one criticality question; service-description questions do not set a tier.');
      qs.splice(i, 1);
      return { model: next, focus: Math.min(i, qs.length - 1) };
    }
    case 'move_up':
    case 'move_down': {
      if (!hasQuestion) return refuse('That question no longer exists.');
      const to = name === 'move_up' ? i - 1 : i + 1;
      if (to < 0 || to >= qs.length) return { model: next, focus: i };
      [qs[i], qs[to]] = [qs[to], qs[i]];
      return { model: next, focus: to };
    }
    case 'add_answer': {
      if (!hasQuestion) return refuse('That question no longer exists.');
      const answers = qs[i].answers;
      if (answers.length >= LIMITS.answers) return refuse(`A question can have at most ${LIMITS.answers} answers.`);
      answers.push({ id: newId('a', new Set(answers.map(x => x.id))), label: `Answer ${answers.length + 1}`, tier: 'Low' });
      return { model: next, focus: i };
    }
    case 'delete_answer': {
      if (!hasQuestion || !Number.isInteger(j) || j < 0 || j >= qs[i].answers.length) return refuse('That answer no longer exists.');
      if (qs[i].answers.length <= 2) return refuse(`Question ${i + 1} needs at least two answers.`);
      qs[i].answers.splice(j, 1);
      return { model: next, focus: i };
    }
    default:
      return { model: next };
  }
}

function describeChanges(from, to) {
  if (!from) return [];
  const changes = [];
  const before = new Map(from.questions.map((x, k) => [x.id, { question: x, index: k }]));
  const after = new Map(to.questions.map((x, k) => [x.id, { question: x, index: k }]));
  for (const [id, { question }] of after) {
    const old = before.get(id);
    if (!old) { changes.push(`Added: "${question.text}"`); continue; }
    if (old.question.text !== question.text) changes.push(`Reworded: "${old.question.text}" → "${question.text}"`);
    if (old.question.kind !== question.kind) changes.push(`"${question.text}" is now a ${question.kind === 'criticality' ? 'criticality' : 'service-description'} question`);
    const oldAnswers = new Map(old.question.answers.map(x => [x.id, x]));
    const newIds = new Set(question.answers.map(x => x.id));
    for (const answer of question.answers) {
      const prior = oldAnswers.get(answer.id);
      if (!prior) changes.push(`"${question.text}": new answer "${answer.label}" (${answer.tier})`);
      else {
        if (prior.label !== answer.label) changes.push(`"${question.text}": answer "${prior.label}" reworded to "${answer.label}"`);
        if (prior.tier !== answer.tier) changes.push(`"${question.text}": "${answer.label}" ${prior.tier} → ${answer.tier}`);
      }
    }
    for (const prior of old.question.answers) {
      if (!newIds.has(prior.id)) changes.push(`"${question.text}": answer "${prior.label}" removed`);
    }
  }
  for (const [id, { question }] of before) if (!after.has(id)) changes.push(`Removed: "${question.text}"`);
  const order = list => list.filter(id => before.has(id) && after.has(id));
  if (order(from.questions.map(x => x.id)).join() !== order(to.questions.map(x => x.id)).join()) changes.push('Questions reordered');
  for (const tier of [...TIERS].reverse()) {
    if (from.intervals[tier] !== to.intervals[tier]) {
      changes.push(`${tier} reassessment interval: ${from.intervals[tier]} → ${to.intervals[tier]} months`);
    }
  }
  return changes;
}

function toModel(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    firmId: Number(row.firm_id),
    version: Number(row.version),
    status: row.status,
    questions: typeof row.questions === 'string' ? JSON.parse(row.questions) : row.questions,
    intervals: {
      Critical: Number(row.interval_months_critical),
      High: Number(row.interval_months_high),
      Medium: Number(row.interval_months_medium),
      Low: Number(row.interval_months_low),
    },
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdByName: row.created_by_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedBy: row.activated_by == null ? null : Number(row.activated_by),
    activatedByName: row.activated_by_name || null,
    activatedAt: row.activated_at,
    retiredBy: row.retired_by == null ? null : Number(row.retired_by),
    retiredByName: row.retired_by_name || null,
    retiredAt: row.retired_at,
    rowVersion: Number(row.row_version),
  };
}

const SELECT_MODEL = `SELECT m.*, cu.name AS created_by_name, au.name AS activated_by_name, ru.name AS retired_by_name
  FROM tp_criticality_models m
  LEFT JOIN users cu ON cu.id = m.created_by
  LEFT JOIN users au ON au.id = m.activated_by
  LEFT JOIN users ru ON ru.id = m.retired_by`;

function firmIdOf(user) {
  const id = Number(user && user.firm_id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function requireSettings(user) {
  const firmId = firmIdOf(user);
  if (!firmId || !access.firmCan(user, SETTINGS_PERMISSION)) {
    throw new CriticalityError('forbidden', 'Only a manager can change the criticality model.');
  }
  return firmId;
}

async function getActiveModel(db, firmId) {
  return toModel(await db.prepare(`${SELECT_MODEL} WHERE m.firm_id=? AND m.status='active'`).get(firmId));
}

async function getVersion(db, firmId, id) {
  const versionId = Number(id);
  if (!Number.isSafeInteger(versionId) || versionId < 1) return null;
  return toModel(await db.prepare(`${SELECT_MODEL} WHERE m.firm_id=? AND m.id=?`).get(firmId, versionId));
}

async function listVersions(db, firmId) {
  return (await db.prepare(`${SELECT_MODEL} WHERE m.firm_id=? ORDER BY m.version DESC`).all(firmId)).map(toModel);
}

async function getDraft(db, firmId) {
  return toModel(await db.prepare(`${SELECT_MODEL} WHERE m.firm_id=? AND m.status='draft'`).get(firmId));
}

function inTransaction(db, fn) {
  return db.inTransaction ? fn() : db.transaction(fn)();
}

async function lockedVersion(db, firmId, id) {
  const versionId = Number(id);
  if (!Number.isSafeInteger(versionId) || versionId < 1) return null;
  return toModel(await db.prepare('SELECT * FROM tp_criticality_models WHERE firm_id=? AND id=? FOR UPDATE').get(firmId, versionId));
}

function assertEditableDraft(model, rowVersion) {
  if (!model) throw new CriticalityError('not_found', 'This criticality model version does not exist.');
  if (model.status !== 'draft') {
    throw new CriticalityError('not_draft', `Version ${model.version} is ${model.status}; only a draft can be changed.`, { model });
  }
  if (rowVersion !== undefined && Number(rowVersion) !== model.rowVersion) {
    throw new CriticalityError('stale', 'Someone else changed this draft since you opened it. Reload it and make your change again.', { model });
  }
}

async function createDraft(db, user) {
  const firmId = requireSettings(user);
  return inTransaction(db, async () => {
    const active = toModel(await db.prepare(`SELECT * FROM tp_criticality_models WHERE firm_id=? AND status='active' FOR UPDATE`).get(firmId));
    const existing = await getDraft(db, firmId);
    if (existing) return { model: existing, created: false };
    const source = active || { questions: STARTER_QUESTIONS, intervals: DEFAULT_INTERVALS };
    const { next } = await db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM tp_criticality_models WHERE firm_id=?').get(firmId);
    const row = await db.prepare(`INSERT INTO tp_criticality_models
      (firm_id, version, status, questions, interval_months_critical, interval_months_high, interval_months_medium, interval_months_low, created_by)
      VALUES (?, ?, 'draft', ?::jsonb, ?, ?, ?, ?, ?) RETURNING id`)
      .get(firmId, next, JSON.stringify(source.questions), source.intervals.Critical, source.intervals.High,
        source.intervals.Medium, source.intervals.Low, user.id || null);
    return { model: await getVersion(db, firmId, row.id), created: true, basedOn: active ? active.version : null };
  });
}

async function saveDraft(db, user, id, { questions, intervals, rowVersion }) {
  const firmId = requireSettings(user);
  const candidate = { questions, intervals };
  const errors = validateModel(candidate);
  return inTransaction(db, async () => {
    const draft = await lockedVersion(db, firmId, id);
    assertEditableDraft(draft, rowVersion);
    if (errors.length) throw new CriticalityError('invalid', 'The draft was not saved.', { errors, model: draft });
    await db.prepare(`UPDATE tp_criticality_models SET questions=?::jsonb,
      interval_months_critical=?, interval_months_high=?, interval_months_medium=?, interval_months_low=?,
      updated_at=now(), row_version=row_version + 1
      WHERE id=? AND firm_id=? AND status='draft'`)
      .run(JSON.stringify(questions), intervals.Critical, intervals.High, intervals.Medium, intervals.Low, draft.id, firmId);
    return await getVersion(db, firmId, draft.id);
  });
}

async function activateDraft(db, user, id, { rowVersion } = {}) {
  const firmId = requireSettings(user);
  return inTransaction(db, async () => {
    const active = toModel(await db.prepare(`SELECT * FROM tp_criticality_models WHERE firm_id=? AND status='active' FOR UPDATE`).get(firmId));
    const draft = await lockedVersion(db, firmId, id);
    assertEditableDraft(draft, rowVersion);
    const errors = validateModel(draft);
    if (errors.length) throw new CriticalityError('invalid', 'This draft cannot be activated yet.', { errors, model: draft });
    if (active) {
      await db.prepare(`UPDATE tp_criticality_models SET status='retired', retired_at=now(), retired_by=?,
        updated_at=now(), row_version=row_version + 1 WHERE id=?`).run(user.id || null, active.id);
    }
    await db.prepare(`UPDATE tp_criticality_models SET status='active', activated_at=now(), activated_by=?,
      updated_at=now(), row_version=row_version + 1 WHERE id=?`).run(user.id || null, draft.id);
    return { model: await getVersion(db, firmId, draft.id), retired: active };
  });
}

async function discardDraft(db, user, id, { rowVersion } = {}) {
  const firmId = requireSettings(user);
  return inTransaction(db, async () => {
    const draft = await lockedVersion(db, firmId, id);
    assertEditableDraft(draft, rowVersion);
    await db.prepare(`DELETE FROM tp_criticality_models WHERE id=? AND firm_id=? AND status='draft'`).run(draft.id, firmId);
    return draft;
  });
}

module.exports = {
  TIERS, TIER_RANK, TIER_KEYS, KINDS, STATUSES, DEFAULT_INTERVALS, INTERVAL_MIN, INTERVAL_MAX, LIMITS,
  SETTINGS_PERMISSION, STARTER_QUESTIONS, CriticalityError,
  toTierKey, tierLabel, validateModel, scoreTier, intervalFor, intervalsFor, firmIntervals,
  modelFromForm, applyEdit, describeChanges,
  getActiveModel, getVersion, listVersions, getDraft,
  createDraft, saveDraft, activateDraft, discardDraft,
};
