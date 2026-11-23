'use strict';

const { withToast } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const register = require('../lib/tprm/register');
const assessments = require('../lib/tprm/assessments');
const placement = require('../lib/tprm/placement');
const findings = require('../lib/tprm/findings');
const evidence = require('../lib/tprm/evidence');
const contractReview = require('../lib/tprm/contract-review');
const { TprmError } = require('../lib/tprm/errors');

const NOT_FOUND = 'This third-party risk client does not exist, or it is not available to your account.';
const BASE = '/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid';

function clientView(ws) {
  return { id: ws.id, name: ws.brand_display_name || ws.client_name, sector: ws.sector || null };
}

function registerRoutes(app, deps) {
  const { db, requireAuth, getWorkspace, permissionsFor, listWorkspaces } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };
  const aUrl = (actor, tpId, aid) => `/tprm/clients/${actor.ws.id}/third-parties/${Number(tpId)}/assessments/${Number(aid)}`;
  const crUrl = (actor, tpId, aid) => `${aUrl(actor, tpId, aid)}/contract-review`;

  function handler(fn, { permission = 'tp.view' } = {}) {
    return async (req, res, next) => {
      try {
        const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
        if (!loaded) return res.status(404).render('error', { user: req.user, message: NOT_FOUND });
        const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
        if (permission !== 'tp.view' && !access.can(req.user, actor.perms, permission)) {
          return res.status(403).render('error', { user: req.user, message: 'Your role does not allow changes to this assessment\'s contract checklist.' });
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

  app.get(BASE, requireAuth, async (req, res, next) => {
    try {
      const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
      if (loaded) {
        const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
        const assessment = await assessments.getAssessment(db, actor, req.params.tpId, req.params.aid);
        res.locals.contractReviewPanel = await contractReview.panel(db, actor, assessment);
        res.locals.contractReviewLabels = contractReview.EVENT_LABELS;
        res.locals.cr = contractReview;
      }
    } catch (_) {}
    return next();
  });

  async function load(req, actor) {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
    return { thirdParty, assessment };
  }

  function pageLocals(req, actor, extra) {
    return {
      user: req.user, active: 'tprm-portfolio', tpClient: clientView(actor.ws), tp: placement, at: assessments, cr: contractReview,
      canManage: access.can(req.user, actor.perms, 'tp.manage'), canSettings: access.can(req.user, actor.perms, 'tp.settings'),
      ...extra,
    };
  }

  async function renderChecklist(req, res, actor, { errors = [], values = null, status = 200 } = {}) {
    const { thirdParty, assessment } = await load(req, actor);
    const panel = await contractReview.panel(db, actor, assessment);
    return res.status(status).render('tprm_contract_review', pageLocals(req, actor, { thirdParty, assessment, panel, errors, values }));
  }

  app.get(`${BASE}/contract-review`, requireAuth, handler(async (req, res, actor) => renderChecklist(req, res, actor)));

  app.post(`${BASE}/contract-review/start`, requireAuth, handler(async (req, res, actor) => {
    try {
      const result = await contractReview.start(db, actor, req.params.tpId, req.params.aid);
      return res.redirect(withToast(crUrl(actor, req.params.tpId, req.params.aid), `Contract checklist started: ${result.clauseCount} clauses`));
    } catch (err) {
      if (err instanceof TprmError && err.status === 409) {
        return res.redirect(withToast(`${aUrl(actor, req.params.tpId, req.params.aid)}?step=contract#contract-review`, err.message, 'error'));
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/contract-review`, requireAuth, handler(async (req, res, actor) => {
    try {
      const result = await contractReview.save(db, actor, req.params.tpId, req.params.aid, req.body);
      const message = result.unchanged ? 'No changes to save' : `Contract checklist saved: ${result.changed} clause${result.changed === 1 ? '' : 's'} changed`;
      return res.redirect(withToast(crUrl(actor, req.params.tpId, req.params.aid), message));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderChecklist(req, res, actor, { errors: err.errors || [err.message], values: req.body.rows || null, status: 400 });
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  async function renderFindingForm(req, res, actor, { values = null, errors = [], status = 200 } = {}) {
    const { thirdParty, assessment } = await load(req, actor);
    if (!assessments.evidenceChangeable(assessment)) throw new TprmError(409, contractReview.frozenMessage(assessment));
    const draft = await contractReview.findingDraft(db, actor, assessment, req.params.cid);
    return res.status(status).render('tprm_contract_finding', pageLocals(req, actor, {
      thirdParty, assessment, fd: findings, row: draft.row, errors,
      values: { ...(values || draft.values), evidence: [].concat((values || draft.values).evidence || []).map(String) },
      evidenceList: await evidence.listEvidence(db, actor, assessment),
    }));
  }

  app.get(`${BASE}/contract-review/:cid/finding`, requireAuth, handler(async (req, res, actor) =>
    renderFindingForm(req, res, actor), { permission: 'tp.manage' }));

  app.post(`${BASE}/contract-review/:cid/finding`, requireAuth, handler(async (req, res, actor) => {
    try {
      const { finding, row } = await contractReview.raiseFinding(db, actor, req.params.tpId, req.params.aid, req.params.cid, req.body);
      return res.redirect(withToast(`${crUrl(actor, req.params.tpId, req.params.aid)}#clause-${row.clause_id}`,
        `Finding added and linked to ${row.clause_id}: ${finding.title}`));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderFindingForm(req, res, actor, { values: req.body, errors: err.errors || [err.message], status: 400 });
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));
}

module.exports = { register: registerRoutes };
