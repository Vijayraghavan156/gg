'use strict';

const { withToast } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const register = require('../lib/tprm/register');
const placement = require('../lib/tprm/placement');
const exitPlans = require('../lib/tprm/exit-plans');
const subprocessors = require('../lib/tprm/subprocessors');
const { TprmError } = require('../lib/tprm/errors');

const NOT_FOUND = 'This third-party risk client does not exist, or it is not available to your account.';
const TP = '/tprm/clients/:wsId/third-parties/:tpId';

function clientView(ws) {
  return { id: ws.id, name: ws.brand_display_name || ws.client_name, sector: ws.sector || null };
}

function registerRoutes(app, deps) {
  const { db, requireAuth, getWorkspace, permissionsFor, listWorkspaces } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };
  const tpUrl = (actor, tpId, hash = '') => `/tprm/clients/${actor.ws.id}/third-parties/${Number(tpId)}${hash}`;

  function renderPage(req, res, view, actor, locals = {}, status = 200) {
    return res.status(status).render(view, {
      user: req.user, active: 'tprm-portfolio', tpClient: clientView(actor.ws), tp: placement,
      canManage: access.can(req.user, actor.perms, 'tp.manage'),
      canSettings: access.can(req.user, actor.perms, 'tp.settings'),
      ...locals,
    });
  }

  function handler(fn, { permission = 'tp.view' } = {}) {
    return async (req, res, next) => {
      try {
        const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
        if (!loaded) return res.status(404).render('error', { user: req.user, message: NOT_FOUND });
        const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
        if (permission !== 'tp.view' && !access.can(req.user, actor.perms, permission)) {
          return res.status(403).render('error', { user: req.user, message: 'Your role does not allow changes to this client\'s third parties.' });
        }
        const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
        return await fn(req, res, actor, thirdParty);
      } catch (err) {
        if (err instanceof TprmError) {
          return res.status(err.status >= 400 && err.status < 600 ? err.status : 500).render('error', { user: req.user, message: err.message });
        }
        return next(err);
      }
    };
  }

  async function back(res, url, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return res.redirect(withToast(url, err.message, 'error'));
      throw err;
    }
  }

  app.get(TP, requireAuth, async (req, res, next) => {
    try {
      const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
      if (loaded && /^\d+$/.test(String(req.params.tpId))) {
        const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
        const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
        res.locals.exitPlansPanel = await exitPlans.thirdPartyPanel(db, actor, thirdParty.id);
        res.locals.subprocessorsPanel = await subprocessors.panel(db, actor, thirdParty.id);
      }
    } catch (_) {}
    return next();
  });

  app.post(`${TP}/services/:sid/material`, requireAuth, handler(async (req, res, actor, thirdParty) => {
    const url = tpUrl(actor, thirdParty.id, '#exit-plans');
    const marking = ['1', 'on', 'true', 'yes'].includes(String(Array.isArray(req.body.material) ? req.body.material[0] : req.body.material));
    if (!marking && !access.isManager(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'Only a manager can mark a material service as not material.' });
    }
    return back(res, url, async () => {
      const result = await exitPlans.setMaterial(db, actor, thirdParty.id, req.params.sid, req.body);
      if (!result.changed) return res.redirect(withToast(url, 'No changes to save'));
      const synced = (result.synced || []).length;
      return res.redirect(withToast(url, `${result.material ? 'Marked material' : 'No longer material'}${synced ? ': the draft recommendation\'s exit plan conditions were updated' : ''}`));
    });
  }, { permission: 'tp.manage' }));

  async function renderPlan(req, res, actor, thirdParty, { values = null, errors = [], status = 200 } = {}) {
    const page = await exitPlans.planPage(db, actor, thirdParty.id, req.params.sid);
    return renderPage(req, res, 'tprm_exit_plan', actor, {
      thirdParty, ...page, EP: exitPlans, errors,
      values: values || page.plan || {},
      rowVersion: values ? values.row_version : (page.plan ? page.plan.row_version : 0),
    }, status);
  }

  app.get(`${TP}/services/:sid/exit-plan`, requireAuth, handler(async (req, res, actor, thirdParty) =>
    renderPlan(req, res, actor, thirdParty)));

  app.post(`${TP}/services/:sid/exit-plan`, requireAuth, handler(async (req, res, actor, thirdParty) => {
    let result;
    try {
      result = await exitPlans.savePlan(db, actor, thirdParty.id, req.params.sid, req.body);
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) return renderPlan(req, res, actor, thirdParty, { values: req.body, errors: err.errors || [err.message], status: 400 });
      if (err instanceof TprmError && err.status === 409) {
        return res.redirect(withToast(`${tpUrl(actor, thirdParty.id)}/services/${Number(req.params.sid)}/exit-plan`, err.message, 'error'));
      }
      throw err;
    }
    const url = tpUrl(actor, thirdParty.id, '#exit-plans');
    if (!result.changed) return res.redirect(withToast(url, 'No changes to save'));
    const synced = (result.synced || []).length;
    return res.redirect(withToast(url, `Exit plan saved (${result.plan.status === 'complete' ? 'complete' : 'incomplete'})${synced ? ': the draft recommendation\'s exit plan conditions were updated' : ''}`));
  }, { permission: 'tp.manage' }));

  app.post(`${TP}/subprocessors`, requireAuth, handler(async (req, res, actor, thirdParty) => {
    const url = tpUrl(actor, thirdParty.id, '#subprocessors');
    return back(res, url, async () => {
      await subprocessors.add(db, actor, thirdParty.id, req.body);
      return res.redirect(withToast(url, 'Subprocessor added'));
    });
  }, { permission: 'tp.manage' }));

  async function renderSubprocessor(req, res, actor, thirdParty, { values = null, errors = [], status = 200 } = {}) {
    const row = await subprocessors.getOne(db, actor, thirdParty.id, req.params.spid);
    return renderPage(req, res, 'tprm_subprocessor_form', actor, {
      thirdParty, subprocessor: row, values: values || row, errors, SP: subprocessors,
      helper: await subprocessors.answerHelper(db, actor, thirdParty.id),
    }, status);
  }

  app.get(`${TP}/subprocessors/:spid/edit`, requireAuth, handler(async (req, res, actor, thirdParty) =>
    renderSubprocessor(req, res, actor, thirdParty), { permission: 'tp.manage' }));

  app.post(`${TP}/subprocessors/:spid`, requireAuth, handler(async (req, res, actor, thirdParty) => {
    let result;
    try {
      result = await subprocessors.update(db, actor, thirdParty.id, req.params.spid, req.body);
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderSubprocessor(req, res, actor, thirdParty, { values: req.body, errors: err.errors || [err.message], status: 400 });
      }
      if (err instanceof TprmError && err.status === 409) return res.redirect(withToast(tpUrl(actor, thirdParty.id, '#subprocessors'), err.message, 'error'));
      throw err;
    }
    return res.redirect(withToast(tpUrl(actor, thirdParty.id, '#subprocessors'), result.changed ? 'Subprocessor updated' : 'No changes to save'));
  }, { permission: 'tp.manage' }));

  app.post(`${TP}/subprocessors/:spid/remove`, requireAuth, handler(async (req, res, actor, thirdParty) => {
    const url = tpUrl(actor, thirdParty.id, '#subprocessors');
    return back(res, url, async () => {
      await subprocessors.remove(db, actor, thirdParty.id, req.params.spid, req.body);
      return res.redirect(withToast(url, 'Subprocessor removed'));
    });
  }, { permission: 'tp.manage' }));
}

module.exports = { register: registerRoutes };
