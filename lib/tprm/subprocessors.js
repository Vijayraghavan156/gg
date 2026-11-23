'use strict';

const access = require('./access');
const events = require('./events');
const { TprmError } = require('./errors');

const SOURCES = Object.freeze(['questionnaire', 'manual']);
const SOURCE_LABELS = Object.freeze({ questionnaire: 'From the questionnaire', manual: 'Entered by the firm' });
const LIMITS = Object.freeze({ name: 200, service: 1000, country: 100, perThirdParty: 200 });
const ANSWER_QUESTIONS = Object.freeze(['FTP-01', 'FTP-02', 'FTP-03', 'FTP-04', 'FTP-05', 'FTP-06', 'FTP-07',
  'PRM-06', 'GDP-04', 'FIN-03', 'DOR-06', 'DOR-07', 'PFR-02']);
const EVENT_LABELS = Object.freeze({
  'subprocessor.added': 'Subprocessor added',
  'subprocessor.updated': 'Subprocessor updated',
  'subprocessor.removed': 'Subprocessor removed',
});

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const notFound = () => new TprmError(404, 'This subprocessor does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed this subprocessor after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

function requirePermission(actor, permission) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, permission)) {
    throw new TprmError(403, 'Your role does not allow changes to this client\'s third parties.');
  }
}

const COLUMNS = `sp.id, sp.third_party_id, sp.name, sp.service, sp.country, sp.source, sp.answer_id, sp.created_at, sp.updated_at,
  sp.row_version, an.question_id AS answer_question_id`;

async function thirdPartyOf(db, actor, thirdPartyId, { forUpdate = false } = {}) {
  const id = Number(thirdPartyId);
  if (!Number.isSafeInteger(id) || id < 1) throw new TprmError(404, 'This third party does not exist, or it is not available to your account.');
  const row = await db.prepare(`SELECT id, name FROM tp_third_parties WHERE workspace_id = ? AND id = ?${forUpdate ? ' FOR UPDATE' : ''}`)
    .get(actor.ws.id, id);
  if (!row) throw new TprmError(404, 'This third party does not exist, or it is not available to your account.');
  return row;
}

async function list(db, actor, thirdPartyId) {
  requirePermission(actor, 'tp.view');
  return await db.prepare(`SELECT ${COLUMNS} FROM tp_subprocessors sp
    LEFT JOIN tp_answers an ON an.workspace_id = sp.workspace_id AND an.id = sp.answer_id
    WHERE sp.workspace_id = ? AND sp.third_party_id = ? ORDER BY lower(sp.name), sp.id`).all(actor.ws.id, Number(thirdPartyId));
}

async function getOne(db, actor, thirdPartyId, id, { forUpdate = false } = {}) {
  requirePermission(actor, 'tp.view');
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) throw notFound();
  const row = await db.prepare(`SELECT ${COLUMNS} FROM tp_subprocessors sp
    LEFT JOIN tp_answers an ON an.workspace_id = sp.workspace_id AND an.id = sp.answer_id
    WHERE sp.workspace_id = ? AND sp.third_party_id = ? AND sp.id = ?${forUpdate ? ' FOR UPDATE OF sp' : ''}`)
    .get(actor.ws.id, Number(thirdPartyId), n);
  if (!row) throw notFound();
  return row;
}

async function answerHelper(db, actor, thirdPartyId) {
  requirePermission(actor, 'tp.view');
  const latest = await db.prepare(`SELECT q.id, q.bank_version_id, q.submitted_at FROM tp_questionnaires q
      JOIN tp_assessments a ON a.workspace_id = q.workspace_id AND a.id = q.assessment_id
    WHERE q.workspace_id = ? AND a.third_party_id = ? AND q.submitted_at IS NOT NULL
    ORDER BY q.submitted_at DESC, q.id DESC LIMIT 1`).get(actor.ws.id, Number(thirdPartyId));
  if (!latest) return { submittedAt: null, answers: [] };
  const rows = await db.prepare(`SELECT an.id, an.question_id, an.response, an.detail, an.submitted_at FROM tp_answers an
    WHERE an.workspace_id = ? AND an.questionnaire_id = ? AND an.submitted_at IS NOT NULL
      AND an.question_id IN (${ANSWER_QUESTIONS.map(() => '?').join(',')})`).all(actor.ws.id, latest.id, ...ANSWER_QUESTIONS);
  const bank = await require('./questionnaires').bankContent(db, latest.bank_version_id);
  const themes = new Map((bank.questions || []).map(q => [q.id, q]));
  rows.sort((a, b) => ANSWER_QUESTIONS.indexOf(a.question_id) - ANSWER_QUESTIONS.indexOf(b.question_id));
  return {
    submittedAt: latest.submitted_at,
    answers: rows.map(r => ({
      ...r, theme: themes.get(r.question_id) ? themes.get(r.question_id).theme : null,
      question: themes.get(r.question_id) ? String(themes.get(r.question_id).question || '').replace(/<Client>/g, actor.ws.brand_display_name || actor.ws.client_name || 'the client') : null,
    })),
  };
}

function parse(input) {
  const errors = [];
  const name = str(input.name);
  if (!name) errors.push('Name the subprocessor.');
  else if (name.length > LIMITS.name) errors.push(`The name must be ${LIMITS.name} characters or fewer.`);
  const service = str(input.service) || null;
  if (service && service.length > LIMITS.service) errors.push(`What they do must be ${LIMITS.service} characters or fewer.`);
  const country = str(input.country) || null;
  if (country && country.length > LIMITS.country) errors.push(`The country must be ${LIMITS.country} characters or fewer.`);
  const answerRaw = str(input.answer_id);
  const answerId = answerRaw ? Number(answerRaw) : null;
  if (answerRaw && (!Number.isSafeInteger(answerId) || answerId < 1)) errors.push('Choose the answer from the list.');
  return { values: { name, service, country, answer_id: answerId }, errors };
}

async function checkAnswer(db, actor, thirdPartyId, answerId) {
  if (!answerId) return;
  const offered = (await answerHelper(db, actor, thirdPartyId)).answers;
  if (!offered.some(a => Number(a.id) === Number(answerId))) {
    throw invalid(['Choose an answer of this third party\'s latest submitted questionnaire, or none.']);
  }
}

const FIELDS = ['name', 'service', 'country', 'source', 'answer_id'];
const pick = row => Object.fromEntries(FIELDS.map(f => [f, row[f] == null ? null : (f === 'answer_id' ? Number(row[f]) : row[f])]));

async function add(db, actor, thirdPartyId, input = {}) {
  requirePermission(actor, 'tp.manage');
  const { values, errors } = parse(input);
  if (errors.length) throw invalid(errors);
  return await db.transaction(async () => {
    const tp = await thirdPartyOf(db, actor, thirdPartyId, { forUpdate: true });
    await checkAnswer(db, actor, tp.id, values.answer_id);
    const count = (await db.prepare('SELECT COUNT(*)::integer AS c FROM tp_subprocessors WHERE workspace_id = ? AND third_party_id = ?')
      .get(actor.ws.id, tp.id)).c;
    if (count >= LIMITS.perThirdParty) throw invalid([`A third party can list at most ${LIMITS.perThirdParty} subprocessors.`]);
    const source = values.answer_id ? 'questionnaire' : 'manual';
    const row = await db.prepare(`INSERT INTO tp_subprocessors (workspace_id, third_party_id, name, service, country, source, answer_id,
        created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(actor.ws.id, tp.id, values.name, values.service, values.country, source, values.answer_id, actor.user.id, actor.user.id);
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: tp.id, actorId: actor.user.id, action: 'subprocessor.added',
      after: { subprocessor_id: Number(row.id), ...pick({ ...values, source }) },
    });
    return await getOne(db, actor, tp.id, row.id);
  })();
}

async function update(db, actor, thirdPartyId, id, input = {}) {
  requirePermission(actor, 'tp.manage');
  const { values, errors } = parse(input);
  if (errors.length) throw invalid(errors);
  return await db.transaction(async () => {
    const tp = await thirdPartyOf(db, actor, thirdPartyId, { forUpdate: true });
    const existing = await getOne(db, actor, tp.id, id, { forUpdate: true });
    const rowVersion = Number(input.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== Number(existing.row_version)) throw conflict();
    await checkAnswer(db, actor, tp.id, values.answer_id);
    const next = { ...values, source: values.answer_id ? 'questionnaire' : 'manual' };
    const before = {};
    const after = {};
    const was = pick(existing);
    const now = pick(next);
    for (const f of FIELDS) if (String(was[f]) !== String(now[f])) { before[f] = was[f]; after[f] = now[f]; }
    if (!Object.keys(after).length) return { changed: false, subprocessor: existing };
    const res = await db.prepare(`UPDATE tp_subprocessors SET name = ?, service = ?, country = ?, source = ?, answer_id = ?, updated_by = ?,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(next.name, next.service, next.country, next.source, next.answer_id, actor.user.id, actor.ws.id, existing.id, existing.row_version);
    if (res.changes !== 1) throw conflict();
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: tp.id, actorId: actor.user.id, action: 'subprocessor.updated',
      before: { subprocessor_id: Number(existing.id), ...before }, after: { subprocessor_id: Number(existing.id), ...after },
    });
    return { changed: true, subprocessor: await getOne(db, actor, tp.id, existing.id) };
  })();
}

async function remove(db, actor, thirdPartyId, id, input = {}) {
  requirePermission(actor, 'tp.manage');
  return await db.transaction(async () => {
    const tp = await thirdPartyOf(db, actor, thirdPartyId, { forUpdate: true });
    const existing = await getOne(db, actor, tp.id, id, { forUpdate: true });
    const rowVersion = Number(input.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== Number(existing.row_version)) throw conflict();
    const res = await db.prepare('DELETE FROM tp_subprocessors WHERE workspace_id = ? AND id = ? AND row_version = ?')
      .run(actor.ws.id, existing.id, existing.row_version);
    if (res.changes !== 1) throw conflict();
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: tp.id, actorId: actor.user.id, action: 'subprocessor.removed',
      before: { subprocessor_id: Number(existing.id), ...pick(existing) },
    });
    return existing;
  })();
}

async function panel(db, actor, thirdPartyId) {
  if (!actor || !actor.ws || !access.isFirmUser(actor.user)) return null;
  return {
    list: await list(db, actor, thirdPartyId),
    helper: await answerHelper(db, actor, thirdPartyId),
    canManage: access.can(actor.user, actor.perms, 'tp.manage'),
    SOURCE_LABELS,
    LIMITS,
  };
}

async function inUseRows(db, workspaceId) {
  return await db.prepare(`SELECT sp.name, sp.third_party_id, t.name AS third_party_name, t.workspace_id AS client_id
    FROM tp_subprocessors sp JOIN tp_third_parties t ON t.workspace_id = sp.workspace_id AND t.id = sp.third_party_id
    WHERE sp.workspace_id = ? AND t.status = 'in_use' ORDER BY lower(btrim(sp.name)), t.id`).all(workspaceId);
}

module.exports = {
  SOURCES, SOURCE_LABELS, LIMITS, ANSWER_QUESTIONS, EVENT_LABELS,
  list, getOne, answerHelper, add, update, remove, panel, inUseRows,
};
