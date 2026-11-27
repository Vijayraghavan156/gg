'use strict';

const crypto = require('crypto');
const access = require('./access');
const events = require('./events');
const assessments = require('./assessments');
const assembly = require('./questionnaire-assembly');
const { TprmError } = require('./errors');

const STATUSES = Object.freeze(['draft', 'sent', 'in_progress', 'submitted', 'under_review', 'closed']);
const STATUS_LABELS = Object.freeze({
  draft: 'Draft, not sent',
  sent: 'Sent to the third party',
  in_progress: 'Third party answering',
  submitted: 'Submitted by the third party',
  under_review: 'Under review',
  closed: 'Closed',
});
const STAGES = Object.freeze(['tier_confirmed', 'recommendation_draft']);
const LINKABLE = Object.freeze(['draft', 'sent', 'in_progress']);
const CLARIFICATION_LINKABLE = Object.freeze(['submitted', 'under_review']);
const LINK_STATUS_LABELS = Object.freeze({ active: 'Active', expired: 'Expired', revoked: 'Revoked', submitted: 'Used (submitted)', closed: 'No longer opens' });
const REVOKE_REASONS = Object.freeze({
  replaced: 'Replaced by a new link',
  cancelled: 'Assessment cancelled',
  manual: 'Revoked by the firm',
  reviewed: 'Review closed',
  completed: 'Assessment completed',
  not_returned: 'Questionnaire closed as not returned',
});
const NOT_RETURNED_REASON = 'Not returned by the third party';
const BLOCKS_RECOMMENDATION = Object.freeze(['sent', 'in_progress', 'submitted', 'under_review']);
const NOT_RETURNABLE = Object.freeze(['sent', 'in_progress']);
const LIMITS = Object.freeze({ reason: 500, name: 200, email: 320, expiryDaysMin: 1, expiryDaysMax: 90 });
const DEFAULT_EXPIRY_DAYS = 30;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LINK_PATH = '/vendor/q/';

const EVENT_LABELS = Object.freeze({
  'questionnaire.prepared': 'Questionnaire prepared',
  'questionnaire.module_added': 'Questionnaire module added',
  'questionnaire.module_removed': 'Questionnaire module removed',
  'questionnaire.sent': 'Questionnaire sent',
  'questionnaire.closed': 'Questionnaire closed',
  'questionnaire.not_returned': 'Questionnaire closed as not returned',
  'vendor_link.created': 'Link for the third party created',
  'vendor_link.emailed': 'Link emailed to the third party',
  'vendor_link.revoked': 'Link for the third party revoked',
  'questionnaire.review_started': 'Review of the answers started',
  'questionnaire.reviewed': 'Review of the answers closed',
  'answer.reviewed': 'Answer reviewed',
  'answer.accepted_in_bulk': 'Answer accepted as Satisfactory with the other plain answers',
  'clarification.asked': 'Clarification asked',
  'clarification.closed': 'Clarification closed',
});

const notFound = () => new TprmError(404, 'This questionnaire does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed this questionnaire after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const json = v => JSON.stringify(v);
const hashToken = token => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

class LinkKey {
  constructor(tokenHash) {
    this.tokenHash = tokenHash;
    Object.freeze(this);
  }
}

function keyHash(key) {
  if (key instanceof LinkKey) return /^[0-9a-f]{64}$/.test(key.tokenHash) ? key.tokenHash : null;
  const raw = String(key || '');
  return TOKEN_PATTERN.test(raw) ? hashToken(raw) : null;
}

async function questionnaireKeyFor(db, workspaceId, assessmentId) {
  const row = await db.prepare(`SELECT token_hash FROM tp_vendor_requests WHERE workspace_id = ? AND assessment_id = ? AND status IN ('active', 'submitted')
    AND expires_at > now() ORDER BY created_at DESC LIMIT 1`).get(workspaceId, assessmentId);
  return row ? new LinkKey(row.token_hash) : null;
}

function requireManage(actor, message) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, 'tp.manage')) {
    throw new TprmError(403, message || 'Your role does not allow changes to this questionnaire.');
  }
}

const stageOk = a => !!a && !!a.confirmed_at && STAGES.includes(a.status);

function blockedMessage(a) {
  if (stageOk(a)) return null;
  if (!a.confirmed_at && ['scoping', 'tier_proposed'].includes(a.status)) {
    return 'The questionnaire is assembled from the confirmed tier: confirm the tier first.';
  }
  if (a.status === 'cancelled') return 'This assessment is cancelled, so its questionnaire is closed.';
  if (a.status === 'completed') return 'This assessment is completed, so its questionnaire can no longer change.';
  const frozen = assessments.evidenceFrozenMessage(a);
  return (frozen ? frozen.replace('evidence and findings', 'evidence, findings and questionnaire') + ' ' : '')
    + 'The questionnaire cannot be changed or sent again; an active link can still be revoked.';
}

const bankCache = new Map();

async function latestBankVersion(db) {
  const row = await db.prepare(`SELECT id, version, label, content_sha256, question_count, published_at
    FROM tp_question_bank_versions ORDER BY version DESC LIMIT 1`).get();
  return row ? { ...row, id: Number(row.id), version: Number(row.version) } : null;
}

async function bankContent(db, id) {
  const key = Number(id);
  if (bankCache.has(key)) return bankCache.get(key);
  const row = await db.prepare('SELECT content FROM tp_question_bank_versions WHERE id=?').get(key);
  if (!row) throw new TprmError(500, 'The question bank version this questionnaire was assembled from is missing.');
  const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
  bankCache.set(key, content);
  return content;
}

async function bankFor(db, questionnaire) {
  const bank = await bankContent(db, questionnaire.bank_version_id);
  let extra = questionnaire.custom_questions;
  if (extra === undefined && questionnaire.id && questionnaire.workspace_id) {
    const row = await db.prepare('SELECT custom_questions FROM tp_questionnaires WHERE workspace_id = ? AND id = ?').get(questionnaire.workspace_id, questionnaire.id);
    extra = row ? row.custom_questions : [];
  }
  if (typeof extra === 'string') extra = JSON.parse(extra);
  return Array.isArray(extra) && extra.length ? { ...bank, questions: [...bank.questions, ...extra] } : bank;
}

const Q_COLUMNS = `q.id, q.workspace_id, q.assessment_id, q.bank_version_id, q.bank_version, q.tier, q.delivery_model,
  q.delivery_model_source, q.modules, q.dynamic_modules, q.sections, q.consultant_check_ids, q.vendor_question_count, q.custom_questions, q.template,
  q.status, q.prepared_by, q.prepared_at, q.sent_at, q.closed_at, q.closed_reason, q.created_at, q.updated_at, q.row_version,
  q.submitted_at, q.review_started_at, q.closed_by, q.not_returned, q.not_returned_reason, q.rulebooks`;

async function getQuestionnaire(db, actor, assessment, { forUpdate = false } = {}) {
  const row = await db.prepare(`SELECT ${Q_COLUMNS}${forUpdate ? '' : ', pu.name AS prepared_by_name'}
    FROM tp_questionnaires q ${forUpdate ? '' : 'LEFT JOIN users pu ON pu.id = q.prepared_by'}
    WHERE q.workspace_id = ? AND q.assessment_id = ?${forUpdate ? ' FOR UPDATE' : ''}`).get(actor.ws.id, assessment.id);
  return row || null;
}

async function listLinks(db, actor, questionnaire) {
  if (!questionnaire) return [];
  const rows = await db.prepare(`SELECT r.id, r.recipient_name, r.recipient_email, r.expires_at, r.status, r.created_by,
      r.created_at, r.revoked_by, r.revoked_at, r.revoke_reason, r.last_opened_at, r.emailed_at, r.row_version,
      (r.status = 'active' AND r.expires_at <= now()) AS expired, ${require('./link-access').closedColumns('r', 'a', 't')},
      cu.name AS created_by_name, ru.name AS revoked_by_name
    FROM tp_vendor_requests r
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    LEFT JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users ru ON ru.id = r.revoked_by
    WHERE r.workspace_id = ? AND r.questionnaire_id = ? ORDER BY r.created_at DESC, r.id DESC`).all(actor.ws.id, questionnaire.id);
  const linkAccess = require('./link-access');
  return rows.map(r => {
    const closed = ['active', 'submitted'].includes(r.status) && !r.expired && (r.recipient_left || r.third_party_exited);
    return { ...r, effective_status: r.expired ? 'expired' : closed ? 'closed' : r.status, closed_note: closed ? linkAccess.closedNote(r) : null };
  });
}

async function append(db, actor, assessment, action, before, after) {
  await events.appendEvent(db, {
    workspaceId: actor.ws.id, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id,
    actorId: actor.user.id, action, before, after,
  });
}

async function loadForWrite(db, actor, thirdPartyId, assessmentId) {
  const tp = await require('./register').getThirdParty(db, actor, thirdPartyId, { forUpdate: true });
  const assessment = await assessments.getAssessment(db, actor, tp.id, assessmentId, { forUpdate: true });
  const questionnaire = await getQuestionnaire(db, actor, assessment, { forUpdate: true });
  return { tp, assessment, questionnaire };
}

function assertStage(assessment) {
  const message = blockedMessage(assessment);
  if (message) throw new TprmError(409, message);
}

function checkVersion(row, input) {
  const rowVersion = Number(input && input.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion !== Number(row.row_version)) throw conflict();
}

const includedModules = modules => modules.filter(m => m.included).map(m => m.module);
const dynamicFor = included => assembly.DYNAMIC_MODULES.filter(d => !included.includes(d.module)).map(d => ({ ...d }));

const parseJson = v => (typeof v === 'string' ? JSON.parse(v) : v);
function templateOf(questionnaire) {
  const meta = questionnaire && parseJson(questionnaire.template);
  if (!meta) return null;
  return { meta, rows: parseJson(questionnaire.custom_questions) || [] };
}

function contentFor(bank, { tier, deliveryModel, modules, rulebooks = [], template = null }) {
  const included = includedModules(modules);
  const instead = !!(template && template.meta && template.meta.mode === 'instead');
  const result = instead
    ? assembly.assemble(bank, { tier, deliveryModel, modules: [], rulebooks: rulebooks || [], rulebooksOnly: true })
    : assembly.assemble(bank, { tier, deliveryModel, modules: included, rulebooks: rulebooks || [] });
  const extra = template ? require('./q-templates').sectionsFor(template.meta, template.rows) : [];
  const sections = instead ? [...extra, ...result.sections] : [...result.sections, ...extra];
  const vendorTotal = sections.reduce((n, x) => n + x.ids.length, 0);
  return {
    sections,
    consultant_check_ids: result.consultantChecks.map(c => c.id),
    vendor_question_count: vendorTotal,
    dynamic_modules: instead ? [] : dynamicFor(included),
    counts: { ...result.counts, vendorTotal, template: extra.reduce((n, x) => n + x.ids.length, 0) },
    consultantChecks: result.consultantChecks,
  };
}

async function prepare(db, actor, thirdPartyId, assessmentId, input = {}) {
  requireManage(actor, 'Your role does not allow preparing the questionnaire.');
  try {
    return await db.transaction(async () => {
      const { assessment, questionnaire } = await loadForWrite(db, actor, thirdPartyId, assessmentId);
      assertStage(assessment);
      if (questionnaire) throw new TprmError(409, 'The questionnaire for this assessment is already prepared. Reload the page to see it.');
      if (!assessment.final_tier) throw new TprmError(409, 'This assessment has no final tier.');
      const answers = assessment.answers || {};
      let deliveryModel = assembly.deliveryModelFromAnswers(answers);
      let source = 'assessment_answer';
      if (!deliveryModel) {
        const chosen = str(input.delivery_model);
        if (!assembly.DELIVERY_MODELS.includes(chosen)) {
          throw invalid(['The assessment does not say how the service is delivered. Choose the delivery model for the questionnaire.']);
        }
        deliveryModel = chosen;
        source = 'consultant';
      }
      const bankVersion = await latestBankVersion(db);
      if (!bankVersion) throw new TprmError(409, 'No question bank version is published yet.');
      const bank = await bankContent(db, bankVersion.id);
      const offered = assembly.offeredModules(bank);
      const modules = assembly.autoModules(answers, deliveryModel, bank)
        .filter(m => offered.includes(m.module))
        .map(m => ({ module: m.module, source: 'auto', because: m.because, included: true }));
      const clientRulebooks = await require('./rulebooks').currentForClient(db, actor.ws.id);
      let pinned = clientRulebooks;
      const mode = str(input.questionnaire_mode) || 'automatic';
      if (!require('./q-templates').MODES.includes(mode)) throw invalid(['Choose which questionnaire to send.']);
      const template = mode === 'automatic' ? null : await require('./q-templates').forQuestionnaire(db, actor.ws.firm_id, input.template_id, mode);
      const clash = template ? template.rows.find(r => (bank.questions || []).some(b => b.id === r.id)) : null;
      if (clash) throw invalid([`${clash.id} in "${template.meta.name}" now has the same number as a question bank question. Give that questionnaire a new question code before sending it.`]);
      let leftOut = [];
      if (mode === 'instead' && pinned.length && str(input.rulebooks_choice_shown) === '1' && str(input.include_rulebooks) !== '1') {
        leftOut = pinned.map(r => ({ key: r.key, name: r.name, version: r.version }));
        template.meta.rulebooks_left_out = { rulebooks: leftOut, by: Number(actor.user.id), by_name: actor.user.name || null, at: new Date().toISOString() };
        pinned = [];
      }
      const content = contentFor(bank, { tier: assessment.final_tier, deliveryModel, modules, rulebooks: pinned, template });
      if (!content.vendor_question_count) throw invalid(['This questionnaire would have no questions for the third party.']);
      const row = await db.prepare(`INSERT INTO tp_questionnaires
        (workspace_id, assessment_id, bank_version_id, bank_version, tier, delivery_model, delivery_model_source, modules,
         dynamic_modules, sections, consultant_check_ids, vendor_question_count, prepared_by, rulebooks, custom_questions, template)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb) RETURNING id`)
        .get(actor.ws.id, assessment.id, bankVersion.id, bankVersion.version, assessment.final_tier, deliveryModel, source,
          json(modules), json(content.dynamic_modules), json(content.sections), json(content.consultant_check_ids),
          content.vendor_question_count, actor.user.id, json(pinned), json(template ? template.rows : []), template ? json(template.meta) : null);
      await append(db, actor, assessment, 'questionnaire.prepared', null, {
        questionnaire_id: Number(row.id), bank_version: bankVersion.version, bank_sha256: bankVersion.content_sha256,
        tier: assessment.final_tier, delivery_model: deliveryModel, delivery_model_source: source,
        modules: includedModules(modules), dynamic_modules: content.dynamic_modules.map(d => d.module),
        rulebooks: pinned.map(r => ({ key: r.key, version: r.version, version_id: r.version_id })),
        rulebook_question_count: Object.values(content.counts.rulebooks).reduce((n, c) => n + c, 0),
        vendor_question_count: content.vendor_question_count, consultant_check_count: content.consultant_check_ids.length,
        ...(template ? { firm_questionnaire: { id: template.meta.template_id, name: template.meta.name, version: template.meta.version, mode } } : {}),
        ...(leftOut.length ? { rulebooks_left_out: leftOut.map(r => r.name) } : {}),
      });
      await require('./contract-review').addRulebookClauses(db, actor, assessment, require('./rulebooks').tagsOf(clientRulebooks));
      await require('./exit-plans').syncAssessment(db, actor, assessment, 'questionnaire_prepared');
      return await getQuestionnaire(db, actor, assessment);
    })();
  } catch (err) {
    if (require('../pg').isUniqueViolation(err)) {
      throw new TprmError(409, 'The questionnaire for this assessment is already prepared. Reload the page to see it.');
    }
    throw err;
  }
}

async function changeModule(db, actor, thirdPartyId, assessmentId, input = {}) {
  requireManage(actor);
  const op = str(input.op);
  const name = str(input.module);
  const reason = str(input.reason);
  if (!['add', 'remove'].includes(op)) throw invalid(['Choose whether to add or remove the module.']);
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForWrite(db, actor, thirdPartyId, assessmentId);
    if (!questionnaire) throw notFound();
    assertStage(assessment);
    checkVersion(questionnaire, input);
    if (questionnaire.status !== 'draft') {
      throw new TprmError(409, 'The questionnaire has been sent, so its modules can no longer change.');
    }
    const bank = await bankFor(db, questionnaire);
    const errors = [];
    if (!assembly.moduleCatalog(bank).includes(name)) errors.push('Choose a module from the list.');
    else if (assembly.DISABLED_MODULES.includes(name)) errors.push(`The "${name}" module is switched off.`);
    if (!reason) errors.push(`Say why the module is ${op === 'add' ? 'added' : 'removed'}.`);
    else if (reason.length > LIMITS.reason) errors.push(`The reason must be ${LIMITS.reason} characters or fewer.`);
    if (errors.length) throw invalid(errors);
    const modules = (questionnaire.modules || []).map(m => ({ ...m }));
    let entry = modules.find(m => m.module === name);
    if (op === 'add' && entry && entry.included) throw invalid([`"${name}" is already in the questionnaire.`]);
    if (op === 'remove' && !(entry && entry.included)) throw invalid([`"${name}" is not in the questionnaire.`]);
    const stamp = { changed_by: Number(actor.user.id), changed_by_name: actor.user.name || null, changed_at: new Date().toISOString(), reason };
    if (!entry) {
      entry = { module: name, source: 'manual', because: null, included: true, ...stamp };
      modules.push(entry);
    } else {
      Object.assign(entry, { included: op === 'add' }, stamp);
    }
    const content = contentFor(bank, { tier: questionnaire.tier, deliveryModel: questionnaire.delivery_model, modules,
      rulebooks: questionnaire.rulebooks, template: templateOf(questionnaire) });
    const before = { modules: includedModules(questionnaire.modules || []), vendor_question_count: questionnaire.vendor_question_count };
    const res = await db.prepare(`UPDATE tp_questionnaires SET modules = ?::jsonb, dynamic_modules = ?::jsonb, sections = ?::jsonb,
        consultant_check_ids = ?::jsonb, vendor_question_count = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(json(modules), json(content.dynamic_modules), json(content.sections), json(content.consultant_check_ids),
        content.vendor_question_count, actor.ws.id, questionnaire.id, questionnaire.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, op === 'add' ? 'questionnaire.module_added' : 'questionnaire.module_removed', before, {
      questionnaire_id: Number(questionnaire.id), module: name, source: entry.source, reason,
      modules: includedModules(modules), vendor_question_count: content.vendor_question_count,
    });
    return { questionnaire: await getQuestionnaire(db, actor, assessment), module: name, op };
  })();
}

function parseRecipient(input) {
  const errors = [];
  const name = str(input.recipient_name);
  const email = str(input.recipient_email).toLowerCase();
  if (!name) errors.push('Give the name of the person at the third party who answers.');
  else if (name.length > LIMITS.name) errors.push(`The name must be ${LIMITS.name} characters or fewer.`);
  if (!email) errors.push('Give their email address.');
  else if (email.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Give a valid email address.');
  const daysRaw = str(input.expires_in_days);
  const days = daysRaw === '' ? DEFAULT_EXPIRY_DAYS : Number(daysRaw);
  if (!Number.isInteger(days) || days < LIMITS.expiryDaysMin || days > LIMITS.expiryDaysMax) {
    errors.push(`The link lasts from ${LIMITS.expiryDaysMin} to ${LIMITS.expiryDaysMax} days.`);
  }
  if (errors.length) throw invalid(errors);
  return { name, email, days };
}

async function revokeActive(db, actor, assessment, questionnaire, reason) {
  const active = await db.prepare(`SELECT id, recipient_email, expires_at, (expires_at <= now()) AS expired FROM tp_vendor_requests
    WHERE workspace_id = ? AND questionnaire_id = ? AND status = 'active' FOR UPDATE`).all(actor.ws.id, questionnaire.id);
  for (const r of active) {
    await db.prepare(`UPDATE tp_vendor_requests SET status = 'revoked', revoked_by = ?, revoked_at = now(), revoke_reason = ?,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
      .run(actor.user.id, reason, actor.ws.id, r.id);
    await append(db, actor, assessment, 'vendor_link.revoked', { request_id: Number(r.id), status: r.expired ? 'expired' : 'active' },
      { request_id: Number(r.id), status: 'revoked', reason, questionnaire_id: Number(questionnaire.id) });
  }
  return active.map(r => Number(r.id));
}

async function linkable(db, actor, questionnaire) {
  if (!questionnaire) return false;
  if (LINKABLE.includes(questionnaire.status)) return true;
  if (!CLARIFICATION_LINKABLE.includes(questionnaire.status)) return false;
  const open = await db.prepare(`SELECT 1 FROM tp_clarifications WHERE workspace_id = ? AND questionnaire_id = ? AND status = 'open' LIMIT 1`)
    .get(actor.ws.id, questionnaire.id);
  return !!open;
}

function linkUrl(token) {
  return `${require('../email').appBaseUrl()}${LINK_PATH}${token}`;
}

async function createLink(db, actor, thirdPartyId, assessmentId, input = {}) {
  requireManage(actor, 'Your role does not allow sending the questionnaire.');
  const recipient = parseRecipient(input);
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForWrite(db, actor, thirdPartyId, assessmentId);
    if (!questionnaire) throw new TprmError(409, 'Prepare the questionnaire before creating a link.');
    assertStage(assessment);
    checkVersion(questionnaire, input);
    if (!(await linkable(db, actor, questionnaire))) {
      throw new TprmError(409, CLARIFICATION_LINKABLE.includes(questionnaire.status)
        ? 'The questionnaire has been submitted: a new link is issued only while a clarification is open, so the third party can answer it.'
        : `The questionnaire is "${STATUS_LABELS[questionnaire.status]}", so no new link can be created.`);
    }
    if (!questionnaire.vendor_question_count) throw new TprmError(409, 'The questionnaire has no questions for the third party.');
    const replaced = await revokeActive(db, actor, assessment, questionnaire, REVOKE_REASONS.replaced);
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const row = await db.prepare(`INSERT INTO tp_vendor_requests
      (workspace_id, assessment_id, questionnaire_id, token_hash, token_sealed, recipient_name, recipient_email, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, now() + (?::integer * interval '1 day'), ?) RETURNING id, expires_at`)
      .get(actor.ws.id, assessment.id, questionnaire.id, hashToken(token), require('../encryption').encrypt(token, actor.ws.id),
        recipient.name, recipient.email, recipient.days, actor.user.id);
    if (questionnaire.status === 'draft') {
      const res = await db.prepare(`UPDATE tp_questionnaires SET status = 'sent', sent_at = now(), updated_at = now(),
          row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
        .run(actor.ws.id, questionnaire.id, questionnaire.row_version);
      if (res.changes !== 1) throw conflict();
      await append(db, actor, assessment, 'questionnaire.sent', { status: 'draft' },
        { status: 'sent', questionnaire_id: Number(questionnaire.id), vendor_question_count: questionnaire.vendor_question_count });
      await require('./vendor-answers').prefillFromPrevious(db, {
        workspaceId: actor.ws.id, assessment, questionnaireId: questionnaire.id,
        ids: (questionnaire.sections || []).flatMap(s => s.ids), actorId: actor.user.id,
      });
    } else {
      await db.prepare(`UPDATE tp_questionnaires SET updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ?`).run(actor.ws.id, questionnaire.id);
    }
    await append(db, actor, assessment, 'vendor_link.created', null, {
      request_id: Number(row.id), questionnaire_id: Number(questionnaire.id), recipient_name: recipient.name,
      recipient_email: recipient.email, expires_at: new Date(row.expires_at).toISOString(), expires_in_days: recipient.days,
      ...(replaced.length ? { replaced_request_ids: replaced } : {}),
    });
    const request = await db.prepare('SELECT * FROM tp_vendor_requests WHERE workspace_id = ? AND id = ?').get(actor.ws.id, row.id);
    delete request.token_sealed;
    return { request, token, url: linkUrl(token), replaced, assessment };
  })();
}

async function emailLink(db, actor, assessment, request, url) {
  requireManage(actor);
  const email = require('../email');
  const clientName = actor.ws.brand_display_name || actor.ws.client_name;
  let result;
  try {
    const format = require('./format');
    const firm = await db.prepare('SELECT timezone FROM firms WHERE id = ?').get(actor.ws.firm_id);
    const lh = await require('./letterhead').getLetterhead(db, actor.ws.firm_id).catch(() => null);
    const facts = await require('./vendor-answers').invitationFacts(db, {
      workspaceId: actor.ws.id, assessmentId: Number(request.assessment_id), questionnaireId: Number(request.questionnaire_id),
      firmId: actor.ws.firm_id, clientName,
    });
    const q = await db.prepare('SELECT status FROM tp_questionnaires WHERE workspace_id = ? AND id = ?').get(actor.ws.id, request.questionnaire_id);
    const open = q && CLARIFICATION_LINKABLE.includes(q.status)
      ? await db.prepare(`SELECT question_id, body FROM tp_clarifications WHERE workspace_id = ? AND questionnaire_id = ? AND status = 'open'
          ORDER BY id`).all(actor.ws.id, request.questionnaire_id) : [];
    if (open.length) {
      const m = email.renderTprmEmail('vendor_clarification', {
        toName: request.recipient_name, firmName: lh ? lh.displayName : '', clientName, url,
        until: format.forZone(format.zoneOf(actor.ws, firm)).day(request.expires_at),
        questionId: open.length === 1 ? open[0].question_id : '',
        body: open.length === 1 ? open[0].body : open.map(c => `${c.question_id}: ${c.body}`).join('\n\n'),
        count: open.length,
        contact: actor.user && actor.user.email ? { name: actor.user.name || '', email: actor.user.email } : null,
      }, await require('./email-templates').overrideFor(db, actor.ws.firm_id, 'vendor_clarification'));
      result = await email.sendEmail({ to: request.recipient_email, subject: m.subject, html: m.html, text: m.text, firmId: actor.ws.firm_id,
        workspaceId: actor.ws.id, relatedType: 'tp_vendor_request', relatedId: request.id, outboxRedactions: [url, String(url).split('/').pop()] });
    } else result = await email.sendVendorQuestionnaireEmail({
      toEmail: request.recipient_email, toName: request.recipient_name, clientName, url,
      expiresAt: request.expires_at, workspaceId: actor.ws.id, firmId: actor.ws.firm_id, requestId: request.id,
      firmName: lh ? lh.displayName : '', expiryDay: format.forZone(format.zoneOf(actor.ws, firm)).day(request.expires_at),
      contact: actor.user && actor.user.email ? { name: actor.user.name || '', email: actor.user.email } : null,
      facts,
      override: await require('./email-templates').overrideFor(db, actor.ws.firm_id, 'vendor_invitation'),
      thirdPartyName: ((await db.prepare('SELECT name FROM tp_third_parties WHERE workspace_id = ? AND id = ?').get(actor.ws.id, assessment.third_party_id)) || {}).name || '',
    });
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  if (!result.ok) return { ok: false, error: result.error || 'The email could not be sent.' };
  if (result.provider === 'disabled') return { ok: false, error: 'email delivery is switched off on this server' };
  await db.transaction(async () => {
    await db.prepare(`UPDATE tp_vendor_requests SET emailed_at = now(), updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND status = 'active'`).run(actor.ws.id, request.id);
    await append(db, actor, assessment, 'vendor_link.emailed', null,
      { request_id: Number(request.id), recipient_email: request.recipient_email, provider: result.provider || null });
  })();
  return { ok: true };
}

async function revokeLink(db, actor, thirdPartyId, assessmentId, requestId, input = {}) {
  requireManage(actor, 'Your role does not allow revoking the link.');
  const reason = str(input.reason) || REVOKE_REASONS.manual;
  if (reason.length > LIMITS.reason) throw invalid([`The reason must be ${LIMITS.reason} characters or fewer.`]);
  const id = Number(requestId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForWrite(db, actor, thirdPartyId, assessmentId);
    if (!questionnaire) throw notFound();
    const request = await db.prepare(`SELECT id, status, row_version, (expires_at <= now()) AS expired FROM tp_vendor_requests
      WHERE workspace_id = ? AND questionnaire_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, questionnaire.id, id);
    if (!request) throw notFound();
    checkVersion(request, input);
    if (request.status !== 'active') throw new TprmError(409, 'This link is no longer active.');
    await db.prepare(`UPDATE tp_vendor_requests SET status = 'revoked', revoked_by = ?, revoked_at = now(), revoke_reason = ?,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
      .run(actor.user.id, reason, actor.ws.id, id);
    await append(db, actor, assessment, 'vendor_link.revoked', { request_id: id, status: request.expired ? 'expired' : 'active' },
      { request_id: id, status: 'revoked', reason, questionnaire_id: Number(questionnaire.id) });
    return { assessment };
  })();
}

async function closeForCancelledAssessment(db, actor, assessment) {
  const questionnaire = await getQuestionnaire(db, actor, assessment, { forUpdate: true });
  if (!questionnaire || questionnaire.status === 'closed') return null;
  const revoked = await revokeActive(db, actor, assessment, questionnaire, REVOKE_REASONS.cancelled);
  await db.prepare(`UPDATE tp_questionnaires SET status = 'closed', closed_at = now(), closed_reason = ?, updated_at = now(),
      row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(REVOKE_REASONS.cancelled, actor.ws.id, questionnaire.id);
  await append(db, actor, assessment, 'questionnaire.closed', { status: questionnaire.status },
    { status: 'closed', reason: REVOKE_REASONS.cancelled, questionnaire_id: Number(questionnaire.id), revoked_request_ids: revoked });
  return { revoked };
}

async function closeNotReturned(db, actor, thirdPartyId, assessmentId, input = {}) {
  requireManage(actor, 'Your role does not allow closing the questionnaire.');
  const reason = str(input.reason);
  if (!reason) throw invalid(['Say why the questionnaire is closed without the third party\'s answers.']);
  if (reason.length > LIMITS.reason) throw invalid([`The reason must be ${LIMITS.reason} characters or fewer.`]);
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForWrite(db, actor, thirdPartyId, assessmentId);
    if (!questionnaire) throw notFound();
    checkVersion(questionnaire, input);
    if (['completed', 'cancelled'].includes(assessment.status)) {
      throw new TprmError(409, `This assessment is ${assessment.status}, so its questionnaire can no longer change.`);
    }
    if (!NOT_RETURNABLE.includes(questionnaire.status)) {
      throw new TprmError(409, questionnaire.status === 'draft'
        ? 'The questionnaire has not been sent, so there is nothing to close: a draft does not hold up the recommendation.'
        : `The questionnaire is "${STATUS_LABELS[questionnaire.status]}": only a sent questionnaire the third party has not submitted is closed as not returned.`);
    }
    const revoked = await revokeActive(db, actor, assessment, questionnaire, REVOKE_REASONS.not_returned);
    const res = await db.prepare(`UPDATE tp_questionnaires SET status = 'closed', closed_at = now(), closed_reason = ?, closed_by = ?,
        not_returned = true, not_returned_reason = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(NOT_RETURNED_REASON, actor.user.id, reason, actor.ws.id, questionnaire.id, questionnaire.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, 'questionnaire.not_returned', { status: questionnaire.status }, {
      status: 'closed', reason: NOT_RETURNED_REASON, not_returned_reason: reason, questionnaire_id: Number(questionnaire.id),
      revoked_request_ids: revoked,
    });
    return { assessment, revoked };
  })();
}

async function recommendationGate(db, workspaceId, assessmentId) {
  const q = await db.prepare(`SELECT status, not_returned, not_returned_reason, closed_at FROM tp_questionnaires
    WHERE workspace_id = ? AND assessment_id = ?`).get(workspaceId, assessmentId);
  if (!q) return { blocked: null, status: null, notReturned: null };
  let blocked = null;
  if (NOT_RETURNABLE.includes(q.status)) {
    blocked = 'The questionnaire was sent to the third party and is not closed. Close the review of its answers once it is '
      + 'submitted, or close it as not returned, before the recommendation is submitted for review.';
  } else if (BLOCKS_RECOMMENDATION.includes(q.status)) {
    blocked = 'The third party submitted the questionnaire: close the review of its answers (every answer concluded, every '
      + 'clarification closed) before the recommendation is submitted for review.';
  }
  return {
    blocked,
    status: q.status,
    notReturned: q.not_returned ? { reason: q.not_returned_reason, closedAt: q.closed_at } : null,
  };
}

async function publicLink(db, token) {
  return await require('./vendor-answers').linkContext(db, token);
}

function reminderTarget(links, main) {
  const open = links.find(l => l.status === 'active' && !l.expired);
  if (!open || open.third_party_exited) return null;
  if (!open.recipient_left) return { name: open.recipient_name, email: open.recipient_email, signIn: false };
  return main ? { name: main.name, email: main.email, signIn: true, from: open.recipient_name } : null;
}

async function panel(db, actor, assessment, { answersFilter = null, raise = null } = {}) {
  const canManage = access.can(actor.user, actor.perms, 'tp.manage');
  const questionnaire = await getQuestionnaire(db, actor, assessment);
  const blocked = blockedMessage(assessment);
  const deliveryFromAnswers = assembly.deliveryModelFromAnswers(assessment.answers || {});
  const data = {
    Q: module.exports,
    A: assembly,
    questionnaire,
    blocked,
    tierConfirmed: !!assessment.confirmed_at,
    canPrepare: canManage && !blocked && !questionnaire,
    firmQuestionnaires: canManage && !blocked && !questionnaire && actor.ws.firm_id ? await require('./q-templates').published(db, actor.ws.firm_id) : [],
    modeLabels: require('./q-templates').MODE_LABELS,
    canEditModules: canManage && !blocked && !!questionnaire && questionnaire.status === 'draft',
    canLink: canManage && !blocked && await linkable(db, actor, questionnaire),
    canRevoke: canManage,
    canCloseNotReturned: canManage && !!questionnaire && NOT_RETURNABLE.includes(questionnaire.status)
      && !['completed', 'cancelled'].includes(assessment.status),
    deliveryFromAnswers,
    links: await listLinks(db, actor, questionnaire),
    mainContact: await require('./vendor-people').mainContact(db, actor.ws.id, assessment.third_party_id),
    eventLabels: { ...EVENT_LABELS },
    limits: LIMITS,
    defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
  };
  if (questionnaire) {
    const bank = await bankFor(db, questionnaire);
    const byId = new Map(bank.questions.map(row => [row.id, row]));
    const content = contentFor(bank, { tier: questionnaire.tier, deliveryModel: questionnaire.delivery_model, modules: questionnaire.modules || [], template: templateOf(questionnaire),
      rulebooks: questionnaire.rulebooks });
    data.byId = byId;
    data.counts = content.counts;
    data.sections = questionnaire.sections || [];
    data.consultantChecks = (questionnaire.consultant_check_ids || []).map(id => byId.get(id)).filter(Boolean);
    const included = includedModules(questionnaire.modules || []);
    data.addable = assembly.offeredModules(bank).filter(m => !included.includes(m));
    data.note = assembly.DELIVERY_MODEL_NOTES[questionnaire.delivery_model] || null;
    data.rulebooks = (questionnaire.rulebooks || []).map(r => ({ ...r,
      questions: (data.sections.find(s => s.kind === 'rulebook' && s.title === r.name) || { ids: [] }).ids.length,
      checks: content.consultantChecks.filter(c => c.kind === 'rulebook' && c.title === r.name).length }));
    data.activeLink = data.links.find(l => l.effective_status === 'active') || null;
    data.remindTo = reminderTarget(data.links, data.mainContact);
    data.review = await require('./questionnaire-review').reviewData(db, actor, assessment, questionnaire, bank, { filter: answersFilter, raise });
    Object.assign(data.eventLabels, require('./vendor-answers').EVENT_LABELS, require('./assurance-reports').EVENT_LABELS);
  } else {
    data.note = deliveryFromAnswers ? (assembly.DELIVERY_MODEL_NOTES[deliveryFromAnswers] || null) : null;
    data.rulebooksToPin = await require('./rulebooks').currentForClient(db, actor.ws.id);
  }
  return data;
}

async function linkWorkspaceId(db, token) {
  const row = await db.prepare('SELECT workspace_id FROM tp_vendor_requests WHERE token_hash = ?').get(keyHash(token) || '');
  return row ? Number(row.workspace_id) : null;
}

async function firmEntryTarget(db, workspaceId, thirdPartyId, assessmentId) {
  const a = await db.prepare(`SELECT a.id, q.id AS questionnaire_id, q.status AS q_status FROM tp_assessments a
    JOIN tp_questionnaires q ON q.workspace_id = a.workspace_id AND q.assessment_id = a.id
    WHERE a.workspace_id = ? AND a.id = ? AND a.third_party_id = ?`).get(Number(workspaceId), Number(assessmentId) || 0, Number(thirdPartyId) || 0);
  if (!a) return null;
  const link = await db.prepare(`SELECT token_hash FROM tp_vendor_requests WHERE workspace_id = ? AND questionnaire_id = ? AND status = 'active'
    AND expires_at > now() ORDER BY created_at DESC, id DESC LIMIT 1`).get(Number(workspaceId), Number(a.questionnaire_id));
  return { assessmentId: Number(a.id), questionnaireStatus: a.q_status, key: link ? new LinkKey(link.token_hash) : null };
}

module.exports = { templateOf, bankFor,
  LinkKey, keyHash, questionnaireKeyFor, firmEntryTarget,
  STATUSES, STATUS_LABELS, STAGES, LINKABLE, CLARIFICATION_LINKABLE, LINK_STATUS_LABELS, REVOKE_REASONS, LIMITS, DEFAULT_EXPIRY_DAYS,
  TOKEN_PATTERN, LINK_PATH, EVENT_LABELS, NOT_RETURNED_REASON, BLOCKS_RECOMMENDATION, NOT_RETURNABLE,
  hashToken, linkUrl, blockedMessage, latestBankVersion, bankContent, getQuestionnaire, listLinks, contentFor, loadForWrite, revokeActive,
  append, checkVersion, linkable,
  prepare, changeModule, createLink, emailLink, revokeLink, closeForCancelledAssessment, closeNotReturned, recommendationGate,
  publicLink, panel, linkUrl,
  linkWorkspaceId,
};
