'use strict';

const { withToast, auditCtx } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const criticality = require('../lib/tprm/criticality');
const aiReview = require('../lib/tprm/ai-review');
const { TprmError } = require('../lib/tprm/errors');

const BASE = '/tprm/settings/criticality';

function register(app, deps) {
  const { db, requireAuth, logAction, xlsxUpload } = deps;

  const forbidden = (req, res) => res.status(403).render('error', {
    user: req.user,
    message: 'The criticality model can be changed by managers only.',
  });
  const notFound = (req, res) => res.status(404).render('error', {
    user: req.user,
    message: 'This criticality model version does not exist, or it is not available to your account.',
  });

  const requireSettings = (req, res, next) => {
    if (!access.isFirmUser(req.user) || !access.firmCan(req.user, criticality.SETTINGS_PERMISSION) || !req.user.firm_id) {
      return forbidden(req, res);
    }
    next();
  };

  const firmId = req => Number(req.user.firm_id);
  const versionUrl = model => `${BASE}/versions/${model.id}`;
  const audit = (req, action, model, details = {}) => logAction(req.user.id, null, action, 'criticality_model', model.id,
    { version: model.version, ...details }, auditCtx(req));

  function handleDomainError(req, res, err) {
    if (!(err instanceof criticality.CriticalityError)) throw err;
    if (err.code === 'forbidden') { forbidden(req, res); return true; }
    if (err.code === 'not_found') { notFound(req, res); return true; }
    if (err.code === 'not_draft') { res.redirect(withToast(versionUrl(err.model), err.message, 'error')); return true; }
    return false;
  }

  async function renderVersion(req, res, model, { status = 200, form = null, errors = [], notice = null, focus = null } = {}) {
    const active = await criticality.getActiveModel(db, firmId(req));
    res.status(status).render('tprm_settings_criticality_version', {
      user: req.user,
      active: 'tprm-portfolio',
      model,
      form: form || model,
      errors,
      notice,
      focus,
      activeVersion: active,
      tiers: criticality.TIERS,
      limits: criticality.LIMITS,
      intervalRange: { min: criticality.INTERVAL_MIN, max: criticality.INTERVAL_MAX },
    });
  }

  app.get(BASE, requireAuth, async (req, res) => {
    if (!access.isFirmUser(req.user) || !req.user.firm_id || !access.firmCan(req.user, 'tp.view')) return forbidden(req, res);
    const canEdit = access.firmCan(req.user, criticality.SETTINGS_PERMISSION);
    const versions = canEdit ? await criticality.listVersions(db, firmId(req)) : [];
    res.render('tprm_settings_criticality', {
      user: req.user,
      active: 'tprm-portfolio',
      canEdit,
      activeVersion: canEdit ? (versions.find(v => v.status === 'active') || null) : await criticality.getActiveModel(db, firmId(req)),
      draft: canEdit ? (versions.find(v => v.status === 'draft') || null) : null,
      versions,
      tiers: criticality.TIERS,
    });
  });

  app.post(`${BASE}/drafts`, requireAuth, requireSettings, async (req, res) => {
    try {
      const { model, created, basedOn } = await criticality.createDraft(db, req.user);
      if (created) await audit(req, 'tprm_criticality_draft_created', model, { based_on_version: basedOn });
      res.redirect(withToast(versionUrl(model), created
        ? `Draft version ${model.version} created from the active version`
        : `Version ${model.version} is already in draft`));
    } catch (err) {
      if (!handleDomainError(req, res, err)) throw err;
    }
  });

  app.get(`${BASE}/versions/:id`, requireAuth, requireSettings, async (req, res) => {
    const model = await criticality.getVersion(db, firmId(req), req.params.id);
    if (!model) return notFound(req, res);
    await renderVersion(req, res, model);
  });

  app.post(`${BASE}/versions/:id`, requireAuth, requireSettings, async (req, res) => {
    const model = await criticality.getVersion(db, firmId(req), req.params.id);
    if (!model) return notFound(req, res);
    if (model.status !== 'draft') {
      return res.redirect(withToast(versionUrl(model), `Version ${model.version} is ${model.status}; only a draft can be changed.`, 'error'));
    }
    const posted = criticality.modelFromForm(req.body);
    const op = typeof req.body.op === 'string' ? req.body.op : 'save';
    const edit = criticality.applyEdit(posted, op);
    const form = { ...model, questions: edit.model.questions, intervals: edit.model.intervals };
    if (edit.error) return renderVersion(req, res, model, { status: 400, form, errors: [edit.error], focus: edit.focus });
    try {
      const saved = await criticality.saveDraft(db, req.user, model.id, { ...edit.model, rowVersion: req.body.row_version });
      await audit(req, 'tprm_criticality_draft_saved', saved, { op: op.split(':')[0] });
      if (op === 'review') return res.redirect(withToast(`${versionUrl(saved)}/activate`, 'Draft saved'));
      const anchor = Number.isInteger(edit.focus) ? `#question-${edit.focus + 1}` : '';
      res.redirect(withToast(versionUrl(saved) + anchor, 'Draft saved'));
    } catch (err) {
      if (handleDomainError(req, res, err)) return;
      if (err.code === 'invalid') return renderVersion(req, res, model, { status: 400, form, errors: err.errors, focus: edit.focus });
      if (err.code === 'stale') return renderVersion(req, res, err.model, { status: 409, errors: [err.message] });
      throw err;
    }
  });

  app.get(`${BASE}/versions/:id/activate`, requireAuth, requireSettings, async (req, res) => {
    const model = await criticality.getVersion(db, firmId(req), req.params.id);
    if (!model) return notFound(req, res);
    if (model.status !== 'draft') return res.redirect(versionUrl(model));
    const activeVersion = await criticality.getActiveModel(db, firmId(req));
    res.render('tprm_settings_criticality_activate', {
      user: req.user,
      active: 'tprm-portfolio',
      model,
      activeVersion,
      errors: criticality.validateModel(model),
      changes: criticality.describeChanges(activeVersion, model),
      tiers: criticality.TIERS,
    });
  });

  app.post(`${BASE}/versions/:id/activate`, requireAuth, requireSettings, async (req, res) => {
    try {
      const { model, retired } = await criticality.activateDraft(db, req.user, req.params.id, { rowVersion: req.body.row_version });
      await audit(req, 'tprm_criticality_version_activated', model, { retired_version: retired ? retired.version : null });
      res.redirect(withToast(BASE, `Version ${model.version} is now active${retired ? `; version ${retired.version} is retired` : ''}`));
    } catch (err) {
      if (handleDomainError(req, res, err)) return;
      if (err.code === 'invalid' || err.code === 'stale') {
        return res.redirect(withToast(`${versionUrl(err.model)}/activate`, err.code === 'stale' ? err.message : 'Fix the problems listed before activating', 'error'));
      }
      throw err;
    }
  });

  app.post(`${BASE}/versions/:id/discard`, requireAuth, requireSettings, async (req, res) => {
    try {
      const draft = await criticality.discardDraft(db, req.user, req.params.id, { rowVersion: req.body.row_version });
      await audit(req, 'tprm_criticality_draft_discarded', draft);
      res.redirect(withToast(BASE, `Draft version ${draft.version} discarded`));
    } catch (err) {
      if (handleDomainError(req, res, err)) return;
      if (err.code === 'stale') return res.redirect(withToast(versionUrl(err.model), err.message, 'error'));
      throw err;
    }
  });

  const AI_BASE = '/tprm/settings/ai-review';
  const aiForbidden = (req, res) => res.status(403).render('error', {
    user: req.user,
    message: 'The firm\'s AI review setting can be changed by managers only.',
  });

  app.get(AI_BASE, requireAuth, async (req, res) => {
    if (!access.isFirmUser(req.user) || !req.user.firm_id || !access.firmCan(req.user, 'tp.settings')) return aiForbidden(req, res);
    res.render('tprm_settings_ai', {
      user: req.user,
      active: 'tprm-portfolio',
      setting: await aiReview.autoReview(db, firmId(req)),
      info: aiReview.providerInfo(),
      limits: aiReview.LIMITS,
      notConfigured: aiReview.NOT_CONFIGURED,
    });
  });

  app.post(AI_BASE, requireAuth, async (req, res) => {
    if (!access.isFirmUser(req.user) || !req.user.firm_id || !access.firmCan(req.user, 'tp.settings')) return aiForbidden(req, res);
    try {
      const result = await aiReview.setAutoReview(db, req.user, req.body);
      if (result.changed) {
        await logAction(req.user.id, null, 'tprm_ai_review_setting_changed', 'firm', firmId(req), { automatic_review: result.enabled }, auditCtx(req));
      }
      res.redirect(withToast(AI_BASE, !result.changed ? 'No changes to save'
        : result.enabled ? 'Automatic AI review switched on' : 'Automatic AI review switched off'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 409) return res.redirect(withToast(AI_BASE, err.message, 'error'));
      if (err instanceof TprmError && err.status === 403) return aiForbidden(req, res);
      throw err;
    }
  });
  const guides = require('../lib/tprm/marking-guides');
  const GUIDE_BASE = '/tprm/settings/marking-guides';
  async function renderGuides(req, res, { errors = [], values = null, status = 200 } = {}) {
    const questionnaires = require('../lib/tprm/questionnaires');
    const latest = await questionnaires.latestBankVersion(db);
    const bank = latest ? await questionnaires.bankContent(db, latest.id) : { questions: [] };
    const saved = await guides.forFirm(db, firmId(req));
    const q = String(req.query.q || (values && values.question_id) || '').trim().slice(0, 100);
    const domain = String(req.query.domain || '').trim().slice(0, 100);
    const all = (bank.questions || []).map(x => ({ id: x.id, theme: x.theme, question: x.question, domain: x.set === 'Base' ? x.domain : x.pack,
      guidance: x.guidance || '', benchmark: x.benchmark || '', guide: saved.get(x.id) || null }));
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = all.filter(x => (!domain || x.domain === domain) && words.every(w => `${x.id} ${x.theme} ${x.question}`.toLowerCase().includes(w)));
    return res.status(status).render('tprm_marking_guides', {
      user: req.user, active: 'tprm-portfolio', q, domain, domains: [...new Set(all.map(x => x.domain).filter(Boolean))],
      shown: shown.slice(0, 40), more: Math.max(0, shown.length - 40), total: all.length, written: saved.size,
      canEdit: access.firmCan(req.user, guides.PERMISSION), errors, values, bankVersion: latest ? latest.version : null,
    });
  }

  app.get(GUIDE_BASE, requireAuth, async (req, res, next) => {
    try {
      if (!access.isFirmUser(req.user) || !access.firmCan(req.user, 'tp.view') || !req.user.firm_id) {
        return res.status(403).render('error', { user: req.user, message: 'Marking guides are for consulting-team accounts.' });
      }
      return await renderGuides(req, res);
    } catch (err) { return next(err); }
  });

  app.post(`${GUIDE_BASE}/:qid`, requireAuth, async (req, res, next) => {
    try {
      if (!access.isFirmUser(req.user) || !access.firmCan(req.user, guides.PERMISSION) || !req.user.firm_id) {
        return res.status(403).render('error', { user: req.user, message: 'Only a manager can change the marking guides.' });
      }
      const qid = String(req.params.qid);
      try {
        const r = await guides.save(db, req.user, qid, req.body || {});
        await logAction(req.user.id, null, 'tprm_marking_guide_saved', 'tp_marking_guide', null, { question_id: qid, cleared: !!r.cleared }, auditCtx(req));
        return res.redirect(withToast(`${GUIDE_BASE}?q=${encodeURIComponent(qid)}#guide-${qid}`, r.cleared ? 'Guide removed' : 'Guide saved'));
      } catch (err) {
        if (err instanceof TprmError && err.status === 400) { req.query.q = qid; return await renderGuides(req, res, { errors: err.errors || [err.message], values: { ...req.body, question_id: qid }, status: 400 }); }
        if (err instanceof TprmError && (err.status === 409 || err.status === 404)) return res.redirect(withToast(`${GUIDE_BASE}?q=${encodeURIComponent(qid)}`, err.message, 'error'));
        throw err;
      }
    } catch (err) { return next(err); }
  });

  const emailTemplates = require('../lib/tprm/email-templates');
  const EMAIL_BASE = '/tprm/settings/emails';
  const emailLabels = () => ({ vendor_invitation: 'the questionnaire invitation to the third party', ...require('../lib/tprm/messages').KIND_LABELS });
  async function firmDisplayName(req) {
    const lh = await require('../lib/tprm/letterhead').getLetterhead(db, firmId(req)).catch(() => null);
    return lh ? lh.displayName : '';
  }

  app.get(EMAIL_BASE, requireAuth, async (req, res, next) => {
    try {
      if (!access.isFirmUser(req.user) || !access.firmCan(req.user, 'tp.view') || !req.user.firm_id) {
        return res.status(403).render('error', { user: req.user, message: 'Emails are for consulting-team accounts.' });
      }
      const saved = await emailTemplates.forFirm(db, firmId(req));
      const labels = emailLabels();
      const firmName = await firmDisplayName(req);
      const open = String(req.query.kind || '');
      const list = [];
      for (const k of emailTemplates.kinds()) {
        const std = await emailTemplates.preview(k, null, firmName);
        list.push({ kind: k, label: labels[k] || k.replace(/_/g, ' '), audience: emailTemplates.audienceOf(k), subject: std.subject, saved: saved.get(k) || null });
      }
      return res.render('tprm_email_templates', { user: req.user, active: 'tprm-portfolio', list, open, canEdit: access.firmCan(req.user, emailTemplates.PERMISSION), limits: emailTemplates.LIMITS });
    } catch (err) { return next(err); }
  });

  app.get(`${EMAIL_BASE}/:kind/preview`, requireAuth, async (req, res, next) => {
    try {
      if (!access.isFirmUser(req.user) || !access.firmCan(req.user, 'tp.view') || !req.user.firm_id) return res.status(403).end();
      const kind = String(req.params.kind);
      if (!emailTemplates.kinds().includes(kind)) return res.status(404).end();
      const m = await emailTemplates.preview(kind, await emailTemplates.overrideFor(db, firmId(req), kind), await firmDisplayName(req));
      res.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      res.set('X-Content-Type-Options', 'nosniff');
      return res.type('text/html; charset=utf-8').end(Buffer.from(m.html, 'utf8'));
    } catch (err) { return next(err); }
  });

  app.post(`${EMAIL_BASE}/:kind`, requireAuth, async (req, res, next) => {
    try {
      if (!access.isFirmUser(req.user) || !access.firmCan(req.user, emailTemplates.PERMISSION) || !req.user.firm_id) {
        return res.status(403).render('error', { user: req.user, message: 'Only a manager can change the emails.' });
      }
      const kind = String(req.params.kind);
      try {
        const r = await emailTemplates.save(db, req.user, kind, req.body || {});
        await logAction(req.user.id, null, 'tprm_email_template_saved', 'tp_email_template', null, { kind, reset: !!r.reset }, auditCtx(req));
        return res.redirect(withToast(`${EMAIL_BASE}?kind=${encodeURIComponent(kind)}#email-${kind}`, r.reset ? 'Back to the standard wording' : 'Email saved'));
      } catch (err) {
        if (err instanceof TprmError && [400, 404, 409].includes(err.status)) return res.redirect(withToast(`${EMAIL_BASE}?kind=${encodeURIComponent(kind)}#email-${kind}`, err.message, 'error'));
        throw err;
      }
    } catch (err) { return next(err); }
  });

  const bankEditor = require('../lib/tprm/bank-editor');
  const bankSheet = require('../lib/tprm/bank-sheet');
  const QB = '/tprm/settings/question-bank';
  const canViewBank = req => access.isFirmUser(req.user) && access.firmCan(req.user, 'tp.view') && !!req.user.firm_id;
  const canEditBank = req => access.isFirmUser(req.user) && access.firmCan(req.user, bankEditor.PERMISSION) && !!req.user.firm_id;
  const bankForbidden = (req, res) => res.status(403).render('error', { user: req.user, message: 'Only a manager can change the question bank.' });
  const bankAudit = (req, action, details = {}) => logAction(req.user.id, null, action, 'tp_question_bank', null, details, auditCtx(req));
  const bankBack = (req, url, message, kind) => req.res.redirect(withToast(url, message, kind));

  async function bankAction(req, res, next, fn, { back = QB } = {}) {
    try {
      if (!canEditBank(req)) return bankForbidden(req, res);
      try {
        return await fn();
      } catch (err) {
        if (err instanceof TprmError && [400, 404, 409].includes(err.status)) return bankBack(req, typeof back === 'function' ? back() : back, err.message, 'error');
        if (err instanceof TprmError && err.status === 403) return bankForbidden(req, res);
        throw err;
      }
    } catch (err) { return next(err); }
  }

  function bankRows(content, base, filter) {
    const baseById = new Map(((base && base.questions) || []).map(q => [q.id, q]));
    const changed = new Map();
    if (base) for (const c of bankEditor.diff(base, content).changed) changed.set(c.id, c.fields);
    const term = String(filter.q || '').trim().toLowerCase().slice(0, 100);
    const set = String(filter.set || '');
    const rows = [];
    for (const q of content.questions || []) {
      if (set && q.set !== set) continue;
      if (term && !`${q.id} ${q.theme || ''} ${q.question || ''} ${q.domain || ''} ${q.pack || ''}`.toLowerCase().includes(term)) continue;
      rows.push({ q, group: q.set === 'Base' ? q.domain : q.pack, added: !!base && !baseById.has(q.id), changed: changed.get(q.id) || null });
    }
    const retired = base ? (base.questions || []).filter(q => !(content.questions || []).some(x => x.id === q.id)) : [];
    return { rows, retired, term, set };
  }

  app.get(QB, requireAuth, async (req, res, next) => {
    try {
      if (!canViewBank(req)) return res.status(403).render('error', { user: req.user, message: 'The question bank is for consulting-team accounts.' });
      const st = await bankEditor.state(db);
      if (!st.latest) return res.status(404).render('error', { user: req.user, message: 'No question bank is published yet.' });
      const content = st.draft ? st.draft.content : st.latest.content;
      const view = bankRows(content, st.draft ? st.latest.content : null, req.query || {});
      return res.render('tprm_question_bank', {
        user: req.user, active: 'tprm-portfolio', st, view, canEdit: canEditBank(req),
        history: await bankEditor.history(db), inUse: await bankEditor.inUse(db),
        protectedIds: bankEditor.protectedIds(content), rulebookSet: bankEditor.RULEBOOK_SET,
        sets: [...new Set((content.questions || []).map(q => q.set))],
      });
    } catch (err) { return next(err); }
  });

  app.get(`${QB}/export.xlsx`, requireAuth, async (req, res, next) => {
    try {
      if (!canViewBank(req)) return res.status(403).end();
      const st = await bankEditor.state(db);
      if (!st.latest) return res.status(404).end();
      const draft = !!st.draft;
      const buffer = await bankSheet.buildWorkbook(draft ? st.draft.content : st.latest.content,
        draft ? `Question bank draft, based on version ${st.latest.version}` : `Question bank, ${st.latest.label}`);
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="question-bank-${draft ? 'draft' : `version-${st.latest.version}`}.xlsx"`);
      res.set('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(buffer);
    } catch (err) { return next(err); }
  });

  app.post(`${QB}/draft`, requireAuth, (req, res, next) => bankAction(req, res, next, async () => {
    await bankEditor.startDraft(db, req.user);
    await bankAudit(req, 'tprm_question_bank_draft_started');
    return bankBack(req, QB, 'Draft started. Nothing changes for anyone until you publish it.');
  }));

  app.post(`${QB}/draft/discard`, requireAuth, (req, res, next) => bankAction(req, res, next, async () => {
    const r = await bankEditor.discard(db, req.user);
    if (r.discarded) await bankAudit(req, 'tprm_question_bank_draft_discarded');
    return bankBack(req, QB, r.discarded ? 'Draft discarded' : 'There was no draft to discard');
  }));

  app.post(`${QB}/import`, requireAuth, xlsxUpload.single('sheet'), (req, res, next) => bankAction(req, res, next, async () => {
    if (!req.file || !/\.xlsx$/i.test(String(req.file.originalname || ''))) return bankBack(req, QB, 'Choose the question bank Excel file (.xlsx) to upload.', 'error');
    const rows = await bankSheet.parseUpload(req.file.buffer);
    const r = await bankEditor.importRows(db, req.user, rows);
    await bankAudit(req, 'tprm_question_bank_imported', { changed: r.changed, retired: r.retired, rows: r.rows });
    return bankBack(req, `${QB}/publish`, r.changed || r.retired
      ? `File read: ${r.changed} question${r.changed === 1 ? '' : 's'} changed, ${r.retired} retired, in the draft. Check the changes below.`
      : 'File read: nothing in it differs from the draft.');
  }));

  async function renderQuestion(req, res, { id = null, like = null, values = null, errors = [], status = 200 }) {
    const st = await bankEditor.state(db);
    if (!st.latest) return res.status(404).render('error', { user: req.user, message: 'No question bank is published yet.' });
    if (!id && !st.draft) return res.redirect(withToast(QB, 'Start a draft first.', 'error'));
    const content = st.draft ? st.draft.content : st.latest.content;
    const q = id ? (content.questions || []).find(x => x.id === id) : null;
    const likeQ = like ? (content.questions || []).find(x => x.id === like) : null;
    if ((id && !q) || (!id && !likeQ)) return res.status(404).render('error', { user: req.user, message: 'This question is not in the question bank.' });
    const baseQ = id && st.draft ? (st.latest.content.questions || []).find(x => x.id === id) || null : null;
    return res.status(status).render('tprm_question_bank_question', {
      user: req.user, active: 'tprm-portfolio', st, q, like: likeQ, baseQ, values: values || q || { min_tier: likeQ && likeQ.min_tier, theme: likeQ && likeQ.theme },
      errors, canEdit: canEditBank(req) && !!st.draft, tiers: bankEditor.TIERS, limits: bankEditor.LIMITS,
      isProtected: q ? bankEditor.protectedIds(content).has(q.id) || q.set === bankEditor.RULEBOOK_SET : false,
      nextId: likeQ && st.draft ? bankEditor.nextId(content, likeQ.id.split('-')[0]) : null,
    });
  }

  app.get(`${QB}/add`, requireAuth, async (req, res, next) => {
    try {
      if (!canEditBank(req)) return bankForbidden(req, res);
      return await renderQuestion(req, res, { like: String(req.query.like || '') });
    } catch (err) { return next(err); }
  });

  app.post(`${QB}/add`, requireAuth, (req, res, next) => bankAction(req, res, next, async () => {
    try {
      const r = await bankEditor.addQuestion(db, req.user, req.body || {});
      await bankAudit(req, 'tprm_question_bank_question_added', { question: r.id, beside: String(req.body.like || '') });
      return bankBack(req, `${QB}?q=${encodeURIComponent(r.id)}`, `${r.id} added to the draft`);
    } catch (err) {
      if (err instanceof TprmError && err.status === 400 && err.errors) return await renderQuestion(req, res, { like: String(req.body.like || ''), values: req.body, errors: err.errors, status: 400 });
      throw err;
    }
  }));

  app.get(`${QB}/questions/:id`, requireAuth, async (req, res, next) => {
    try {
      if (!canViewBank(req)) return res.status(403).render('error', { user: req.user, message: 'The question bank is for consulting-team accounts.' });
      return await renderQuestion(req, res, { id: String(req.params.id) });
    } catch (err) { return next(err); }
  });

  app.post(`${QB}/questions/:id`, requireAuth, (req, res, next) => bankAction(req, res, next, async () => {
    const id = String(req.params.id);
    try {
      await bankEditor.updateQuestion(db, req.user, id, req.body || {});
      await bankAudit(req, 'tprm_question_bank_question_changed', { question: id });
      return bankBack(req, `${QB}/questions/${encodeURIComponent(id)}`, `${id} saved in the draft`);
    } catch (err) {
      if (err instanceof TprmError && err.status === 400 && err.errors) return await renderQuestion(req, res, { id, values: req.body, errors: err.errors, status: 400 });
      throw err;
    }
  }, { back: () => `${QB}/questions/${encodeURIComponent(String(req.params.id))}` }));

  app.post(`${QB}/questions/:id/retire`, requireAuth, (req, res, next) => bankAction(req, res, next, async () => {
    const id = String(req.params.id);
    await bankEditor.retireQuestion(db, req.user, id, req.body || {});
    await bankAudit(req, 'tprm_question_bank_question_retired', { question: id });
    return bankBack(req, QB, `${id} retired in the draft. Its number will not be used again.`);
  }, { back: () => `${QB}/questions/${encodeURIComponent(String(req.params.id))}` }));

  app.post(`${QB}/questions/:id/restore`, requireAuth, (req, res, next) => bankAction(req, res, next, async () => {
    const id = String(req.params.id);
    await bankEditor.restoreQuestion(db, req.user, id, req.body || {});
    await bankAudit(req, 'tprm_question_bank_question_restored', { question: id });
    return bankBack(req, `${QB}?q=${encodeURIComponent(id)}`, `${id} brought back`);
  }));

  app.get(`${QB}/publish`, requireAuth, async (req, res, next) => {
    try {
      if (!canEditBank(req)) return bankForbidden(req, res);
      const st = await bankEditor.state(db);
      if (!st.draft) return res.redirect(withToast(QB, 'Start a draft first.', 'error'));
      const base = st.latest.content;
      const byId = new Map((base.questions || []).map(q => [q.id, q]));
      const draftById = new Map((st.draft.content.questions || []).map(q => [q.id, q]));
      const errors = st.stale ? [] : bankEditor.validate(base, st.draft.content, await bankEditor.everUsedIds(db));
      return res.render('tprm_question_bank_publish', {
        user: req.user, active: 'tprm-portfolio', st, d: st.diff, byId, draftById, errors, fields: bankEditor.EDITABLE,
        nextVersion: Number(st.latest.version) + 1,
      });
    } catch (err) { return next(err); }
  });

  app.post(`${QB}/publish`, requireAuth, (req, res, next) => bankAction(req, res, next, async () => {
    const r = await bankEditor.publish(db, req.user, req.body || {});
    await bankAudit(req, 'tprm_question_bank_published', { version: r.version, added: r.diff.added, retired: r.diff.retired, changed: r.diff.changed.map(c => c.id) });
    return bankBack(req, QB, `Version ${r.version} published. New questionnaires use it from now on; ones already prepared keep their version.`);
  }, { back: `${QB}/publish` }));

  const TP_BASE = '/tprm/settings/two-person';
  const twoPerson = require('../lib/tprm/two-person');
  const tpForbidden = (req, res) => res.status(403).render('error', {
    user: req.user,
    message: 'The firm\'s two-person rules can be changed by managers only.',
  });
  const canTwoPerson = req => access.isFirmUser(req.user) && !!req.user.firm_id && access.firmCan(req.user, twoPerson.SETTINGS_PERMISSION);

  app.get(TP_BASE, requireAuth, async (req, res) => {
    if (!canTwoPerson(req)) return tpForbidden(req, res);
    res.render('tprm_settings_two_person', {
      user: req.user,
      active: 'tprm-portfolio',
      setting: await twoPerson.settingsFor(db, firmId(req)),
    });
  });

  app.post(TP_BASE, requireAuth, async (req, res) => {
    if (!canTwoPerson(req)) return tpForbidden(req, res);
    try {
      const result = await twoPerson.setSettings(db, req.user, req.body);
      if (result.changed) {
        await logAction(req.user.id, null, 'tprm_two_person_rules_changed', 'firm', firmId(req), {
          before: { managers_self_approve_tiers: result.before.selfApproveTiers,
            managers_self_issue_recommendations: result.before.selfIssueRecommendations },
          after: { managers_self_approve_tiers: result.after.selfApproveTiers,
            managers_self_issue_recommendations: result.after.selfIssueRecommendations },
        }, auditCtx(req));
      }
      res.redirect(withToast(TP_BASE, result.changed ? 'Two-person rules saved' : 'No changes to save'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 409) return res.redirect(withToast(TP_BASE, err.message, 'error'));
      if (err instanceof TprmError && err.status === 403) return tpForbidden(req, res);
      throw err;
    }
  });
}

module.exports = { register, BASE };
