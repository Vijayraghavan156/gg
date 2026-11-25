'use strict';

const { withToast, auditCtx } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const register = require('../lib/tprm/register');
const placement = require('../lib/tprm/placement');
const reassessment = require('../lib/tprm/reassessment');
const tpFormat = require('../lib/tprm/format');
const concentration = require('../lib/tprm/concentration');
const { TprmError } = require('../lib/tprm/errors');

const NOT_FOUND = 'This third-party risk client does not exist, or it is not available to your account.';

function clientView(ws) {
  return { id: ws.id, name: ws.brand_display_name || ws.client_name, sector: ws.sector || null };
}

function registerRoutes(app, deps) {
  const { db, requireAuth, getWorkspace, permissionsFor, listWorkspaces, logAction } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };
  const tpUrl = (actor, tpId) => `/tprm/clients/${actor.ws.id}/third-parties/${Number(tpId)}`;

  function handler(fn, { permission = 'tp.view' } = {}) {
    return async (req, res, next) => {
      try {
        const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
        if (!loaded) return res.status(404).render('error', { user: req.user, message: NOT_FOUND });
        const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
        if (permission !== 'tp.view' && !access.can(req.user, actor.perms, permission)) {
          return res.status(403).render('error', { user: req.user, message: 'Your role does not allow changes to this client\'s third parties.' });
        }
        return await fn(req, res, actor);
      } catch (err) {
        if (err instanceof TprmError) {
          return res.status(err.status >= 400 && err.status < 600 ? err.status : 500).render('error', { user: req.user, message: err.message });
        }
        return next(err);
      }
    };
  }

  const firmOnly = (req, res) => res.status(403).render('error', {
    user: req.user, message: 'Third-party risk is available to consulting-team accounts.',
  });

  app.get('/tprm/due', requireAuth, async (req, res, next) => {
    try {
      if (!access.isFirmUser(req.user) || !access.firmCan(req.user, 'tp.view')) return firmOnly(req, res);
      const clientId = /^\d{1,12}$/.test(String(req.query.client || '')) ? Number(req.query.client) : null;
      const queue = await reassessment.dueQueue(lookup, req.user, { clientId });
      return res.render('tprm_due', {
        user: req.user, active: 'tprm-portfolio', queue, clientId, R: reassessment, tp: placement,
      });
    } catch (err) { return next(err); }
  });

  const tracker = require('../lib/tprm/questionnaire-tracker');
  const OUT = '/tprm/questionnaires';
  const outBack = req => {
    const keep = new URLSearchParams();
    for (const k of ['show', 'q']) if (typeof req.body[k] === 'string' && req.body[k]) keep.set(k, req.body[k].slice(0, 100));
    return `${OUT}${keep.toString() ? `?${keep}` : ''}`;
  };

  app.get(OUT, requireAuth, async (req, res, next) => {
    try {
      if (!access.isFirmUser(req.user) || !access.firmCan(req.user, 'tp.view')) return firmOnly(req, res);
      const out = await tracker.list(lookup, req.user, { query: req.query });
      return res.render('tprm_questionnaires_out', { user: req.user, active: 'tprm-portfolio', out, T: tracker, tp: placement });
    } catch (err) { return next(err); }
  });

  const outAction = fn => handler(async (req, res, actor) => {
    try {
      return await fn(req, res, actor);
    } catch (err) {
      if (err instanceof TprmError && [400, 404, 409].includes(err.status)) return res.redirect(withToast(outBack(req), err.message, 'error'));
      throw err;
    }
  }, { permission: 'tp.manage' });

  app.post('/tprm/clients/:wsId/questionnaires-out/:aid/remind', requireAuth, outAction(async (req, res, actor) => {
    const r = await require('../lib/tprm/messages').manualReminder(db, { workspaceId: actor.ws.id, assessmentId: Number(req.params.aid) || 0 });
    return res.redirect(withToast(outBack(req), r.sent ? `Reminder sent to ${r.recipient || 'the third party'}` : `No reminder sent: ${r.reason}`, r.sent ? undefined : 'error'));
  }));

  app.post('/tprm/clients/:wsId/questionnaires-out/:aid/reopen', requireAuth, outAction(async (req, res, actor) => {
    const r = await tracker.reopen(db, actor, req.params.aid);
    const until = tpFormat.forZone(tpFormat.zoneOf(actor.ws)).day(r.expiresAt);
    return res.redirect(withToast(outBack(req), r.emailed && r.emailed.ok
      ? `A new link was emailed to ${r.recipient}. It works until ${until}`
      : `A new link was made for ${r.recipient}, working until ${until}, but the email was not sent: ${(r.emailed && r.emailed.error) || 'unknown error'}. Copy the link from the assessment`, r.emailed && r.emailed.ok ? undefined : 'warn'));
  }));

  app.post('/tprm/clients/:wsId/questionnaires-out/:aid/cancel', requireAuth, outAction(async (req, res, actor) => {
    const r = await tracker.cancel(db, actor, req.params.aid, req.body);
    return res.redirect(withToast(outBack(req), `Questionnaire closed as not returned${r.revoked.length ? ': the link no longer works' : ''}. The review carries on without the answers`));
  }));

  async function renderTriggers(req, res, actor, { values = {}, errors = [], status = 200 } = {}) {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const triggers = await reassessment.listTriggers(db, actor, thirdParty.id);
    const open = await reassessment.openTriggers(db, actor.ws.id, [thirdParty]);
    return res.status(status).render('tprm_triggers', {
      user: req.user, active: 'tprm-portfolio', tpClient: clientView(actor.ws), tp: placement, R: reassessment,
      canManage: access.can(req.user, actor.perms, 'tp.manage'), canSettings: access.can(req.user, actor.perms, 'tp.settings'),
      thirdParty, triggers, openTrigger: open.get(Number(thirdParty.id)) || null, values, errors,
    });
  }

  app.get('/tprm/clients/:wsId/third-parties/:tpId/triggers', requireAuth, handler(async (req, res, actor) =>
    renderTriggers(req, res, actor)));

  app.post('/tprm/clients/:wsId/third-parties/:tpId/triggers', requireAuth, handler(async (req, res, actor) => {
    let result;
    try {
      result = await reassessment.recordTrigger(db, actor, req.params.tpId, req.body);
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderTriggers(req, res, actor, { values: req.body, errors: err.errors || [err.message], status: 400 });
      }
      if (err instanceof TprmError && err.status === 409) {
        return res.redirect(withToast(tpUrl(actor, req.params.tpId), err.message, 'error'));
      }
      throw err;
    }
    await logAction(req.user.id, actor.ws.id, 'tprm_reassessment_triggered', 'tp_third_party', Number(result.thirdParty.id),
      { trigger_id: result.triggerId, reason: req.body.reason, previous_due_date: result.previous, next_due_date: result.nextDue }, auditCtx(req));
    return res.redirect(withToast(tpUrl(actor, result.thirdParty.id),
      `Early reassessment triggered: due ${result.nextDue === register.today(actor) ? 'today' : `since ${tpFormat.day(result.nextDue)}`}`));
  }, { permission: 'tp.manage' }));

  app.get('/tprm/clients/:wsId/concentration', requireAuth, handler(async (req, res, actor) => {
    const summary = await concentration.forClient(db, actor);
    return res.render('tprm_concentration', {
      user: req.user, active: 'tprm-portfolio', tpClient: clientView(actor.ws), tp: placement, C: concentration,
      canManage: access.can(req.user, actor.perms, 'tp.manage'), canSettings: access.can(req.user, actor.perms, 'tp.settings'),
      summary, firmWide: false,
    });
  }));

  app.get('/tprm/concentration', requireAuth, async (req, res, next) => {
    try {
      if (!access.isFirmUser(req.user) || !access.firmCan(req.user, 'tp.view')) return firmOnly(req, res);
      if (!access.isManager(req.user)) {
        return res.status(403).render('error', { user: req.user, message: 'The firm-wide concentration view is for managers. Open a client to see its own concentration.' });
      }
      const summary = await concentration.forFirm(lookup, req.user);
      return res.render('tprm_concentration', {
        user: req.user, active: 'tprm-portfolio', tpClient: null, tp: placement, C: concentration, summary, firmWide: true,
      });
    } catch (err) { return next(err); }
  });
}

module.exports = { register: registerRoutes };
