'use strict';

const { withToast, auditCtx } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const criticality = require('../lib/tprm/criticality');
const aiReview = require('../lib/tprm/ai-review');
const { TprmError } = require('../lib/tprm/errors');

const BASE = '/tprm/settings/criticality';

function register(app, deps) {
  const { db, requireAuth, logAction } = deps;

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
