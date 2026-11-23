'use strict';

const { withToast, auditCtx } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const rulebooks = require('../lib/tprm/rulebooks');
const register = require('../lib/tprm/register');
const assessments = require('../lib/tprm/assessments');
const findings = require('../lib/tprm/findings');
const evidence = require('../lib/tprm/evidence');
const { TprmError } = require('../lib/tprm/errors');

const BASE = '/tprm/settings/rulebooks';
const NOT_FOUND = 'This third-party risk client does not exist, or it is not available to your account.';
const A_BASE = '/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid';

function clientView(ws) {
  return { id: ws.id, name: ws.brand_display_name || ws.client_name, sector: ws.sector || null };
}

function registerRoutes(app, deps) {
  const { db, requireAuth, getWorkspace, permissionsFor, listWorkspaces, logAction } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };

  const forbidden = (req, res) => res.status(403).render('error', { user: req.user, message: 'Rulebooks can be changed by managers only.' });
  const notFound = (req, res) => res.status(404).render('error', {
    user: req.user, message: 'This rulebook does not exist, or it is not available to your account.' });
  const requireSettings = (req, res, next) => {
    if (!access.isFirmUser(req.user) || !req.user.firm_id || !access.firmCan(req.user, rulebooks.SETTINGS_PERMISSION)) return forbidden(req, res);
    return next();
  };

  app.get(BASE, requireAuth, requireSettings, async (req, res) => {
    res.render('tprm_settings_rulebooks', {
      user: req.user, active: 'tprm-portfolio', rb: rulebooks,
      list: await rulebooks.listForFirm(db, req.user.firm_id),
    });
  });

  async function renderRulebook(req, res, rulebook, { values = null, errors = [], status = 200 } = {}) {
    res.status(status).render('tprm_settings_rulebook', {
      user: req.user, active: 'tprm-portfolio', rb: rulebooks, rulebook, errors,
      values: values || { ...rulebook, question_ids: (rulebook.question_ids || []).join(', ') },
      versions: await rulebooks.versionsOf(db, req.user.firm_id, rulebook.id),
      countries: rulebooks.countryOptions(),
      packOptions: await rulebooks.packOptions(db),
      clientCount: await rulebooks.clientCount(db, req.user.firm_id, rulebook.id),
    });
  }

  app.get(`${BASE}/:id`, requireAuth, requireSettings, async (req, res) => {
    const rulebook = await rulebooks.getRulebook(db, req.user.firm_id, req.params.id);
    if (!rulebook) return notFound(req, res);
    return renderRulebook(req, res, rulebook);
  });

  app.post(`${BASE}/:id`, requireAuth, requireSettings, async (req, res) => {
    const rulebook = await rulebooks.getRulebook(db, req.user.firm_id, req.params.id);
    if (!rulebook) return notFound(req, res);
    let result;
    try {
      result = await rulebooks.update(db, req.user, rulebook.id, req.body);
    } catch (err) {
      if (!(err instanceof TprmError)) throw err;
      if (err.status === 400) return renderRulebook(req, res, rulebook, { values: req.body, errors: err.errors || [err.message], status: 400 });
      if (err.status === 409) return res.redirect(withToast(`${BASE}/${rulebook.id}`, err.message, 'error'));
      if (err.status === 404) return notFound(req, res);
      if (err.status === 403) return forbidden(req, res);
      throw err;
    }
    if (result.changed) {
      await logAction(req.user.id, null, 'tprm_rulebook_changed', 'tp_rulebook', rulebook.id,
        { key: rulebook.key, version: result.version, before: result.before, after: result.after }, auditCtx(req));
    }
    let message = 'No changes to save';
    if (result.changed && result.versioned) message = `Saved as version ${result.version}. Clients get it from their next questionnaire.`;
    else if (result.changed) message = 'Research note saved (firm-only, the version is unchanged)';
    return res.redirect(withToast(`${BASE}/${rulebook.id}`, message));
  });

  async function loadClient(req, permission = 'tp.view') {
    const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
    if (!loaded) return null;
    const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
    if (permission !== 'tp.view' && !access.can(req.user, actor.perms, permission)) return { actor, forbidden: true };
    return { actor };
  }

  app.get('/tprm/clients/:wsId/settings', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadClient(req, 'tp.settings');
      if (loaded && !loaded.forbidden) res.locals.rulebooksPanel = await rulebooks.clientPanel(db, loaded.actor);
    } catch (_) {}
    return next();
  });

  app.post('/tprm/clients/:wsId/rulebooks', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadClient(req, 'tp.settings');
      if (!loaded) return res.status(404).render('error', { user: req.user, message: NOT_FOUND });
      if (loaded.forbidden) return res.status(403).render('error', { user: req.user, message: 'Only a manager can change the rulebooks of this client.' });
      const { actor } = loaded;
      const back = `/tprm/clients/${actor.ws.id}/settings#rulebooks`;
      let result;
      try {
        result = await rulebooks.setClientTicks(db, actor, req.body);
      } catch (err) {
        if (err instanceof TprmError && [400, 409].includes(err.status)) return res.redirect(withToast(back, err.message, 'error'));
        throw err;
      }
      if (!result.added.length && !result.removed.length) return res.redirect(withToast(back, 'No changes to save'));
      await logAction(req.user.id, actor.ws.id, 'tprm_client_rulebooks_changed', 'workspace', actor.ws.id, {
        added: result.added.map(r => ({ key: r.key, version: Number(r.version) })),
        removed: result.removed.map(r => ({ key: r.key, version: Number(r.version) })),
      }, auditCtx(req));
      return res.redirect(withToast(back, 'Rulebooks saved. They apply from the client\'s next questionnaire.'));
    } catch (err) {
      if (err instanceof TprmError) return res.status(err.status).render('error', { user: req.user, message: err.message });
      return next(err);
    }
  });

  app.get('/tprm/clients/:wsId/third-parties/:tpId', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadClient(req);
      if (loaded && /^\d+$/.test(String(req.params.tpId))) {
        const thirdParty = await register.getThirdParty(db, loaded.actor, req.params.tpId);
        res.locals.dataLocationPanel = await rulebooks.thirdPartyPanel(db, loaded.actor, thirdParty.id);
      }
    } catch (_) {}
    return next();
  });

  app.get(A_BASE, requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadClient(req);
      if (loaded) {
        const assessment = await assessments.getAssessment(db, loaded.actor, req.params.tpId, req.params.aid);
        res.locals.dataLocationPanel = await rulebooks.assessmentPanel(db, loaded.actor, assessment);
      }
    } catch (_) {}
    return next();
  });

  app.get(`${A_BASE}/data-location/finding`, requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadClient(req, 'tp.manage');
      if (!loaded) return res.status(404).render('error', { user: req.user, message: NOT_FOUND });
      if (loaded.forbidden) return res.status(403).render('error', { user: req.user, message: 'Your role does not allow changes to this client\'s assessments.' });
      const { actor } = loaded;
      const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
      const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
      if (!assessments.evidenceChangeable(assessment)) throw new TprmError(409, assessments.evidenceFrozenMessage(assessment));
      const draft = await rulebooks.findingDraft(db, actor, assessment, req.query || {});
      return res.render('tprm_finding_form', {
        user: req.user, active: 'tprm-portfolio', tpClient: clientView(actor.ws), canManage: true,
        canSettings: access.can(req.user, actor.perms, 'tp.settings'), at: assessments, fd: findings,
        thirdParty, assessment, finding: null, errors: [], fromAnswer: null, fromSuggestion: null,
        fromDataLocation: draft.flag, values: draft.values, evidenceList: await evidence.listEvidence(db, actor, assessment),
      });
    } catch (err) {
      if (err instanceof TprmError) {
        return res.status(err.status >= 400 && err.status < 600 ? err.status : 500).render('error', { user: req.user, message: err.message });
      }
      return next(err);
    }
  });
}

module.exports = { register: registerRoutes, BASE };
