'use strict';

const fs = require('fs');
const { withToast, auditCtx } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const tpSettings = require('../lib/tprm/settings');
const tpRegister = require('../lib/tprm/register');
const tpPlacement = require('../lib/tprm/placement');

const { TprmError } = require('../lib/tprm/errors');

const SWITCH_PERMISSION = tpSettings.SWITCH_PERMISSION;

function notFound(req, res) {
  return res.status(404).render('error', {
    user: req.user,
    message: 'This third-party risk client does not exist, or it is not available to your account.',
  });
}

function switchForbidden(req, res) {
  return res.status(403).render('error', {
    user: req.user,
    message: 'Only a manager can switch third-party risk on or off for a client.',
  });
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, getWorkspace, permissionsFor, listWorkspaces, logAction, resolveUploadPath } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };

  const format = require('../lib/tprm/format');
  const { ymdInZone } = require('../lib/dates');
  async function pageLocals(req, res) {
    try {
      const wsMatch = req.originalUrl.match(/^\/(?:tprm\/clients|workspaces)\/(\d+)(?:[/?#]|$)/);
      let zone = null;
      if (wsMatch) {
        zone = await db.prepare(`SELECT w.timezone, w.firm_id, f.timezone AS firm_timezone FROM workspaces w
          LEFT JOIN firms f ON f.id = w.firm_id WHERE w.id = ?`).get(Number(wsMatch[1]));
      }
      if (!zone && req.user && req.user.firm_id) {
        zone = { timezone: null, firm_id: req.user.firm_id, firm_timezone: (await db.prepare('SELECT timezone FROM firms WHERE id = ?').get(req.user.firm_id) || {}).timezone };
      }
      res.locals.tpf = format.forZone(format.zoneOf(zone || {}, null), { ymdInZone });
      res.locals.tpAccent = zone && zone.firm_id ? await require('../lib/tprm/letterhead').brandColour(db, zone.firm_id) : null;
    } catch (_) {
      res.locals.tpf = format.forZone('UTC', { ymdInZone });
    }
  }
  app.use(['/tprm', '/workspaces/:wsId/client-portal/third-party-risk'], (req, res, next) => {
    res.locals.tpLabels = require('../lib/tprm/labels');
    res.locals.canEditGuides = !!(req.user && access.isFirmUser(req.user) && access.firmCan(req.user, 'tp.settings'));
    res.locals.tpf = format.forZone('UTC', { ymdInZone });
    const render = res.render.bind(res);
    res.render = (view, options, callback) => {
      pageLocals(req, res).then(() => render(view, options, callback), err => next(err));
    };
    next();
  });

  app.use(['/tprm/review', '/tprm/due', '/tprm/conditions', '/tprm/settings/rulebooks'], (req, res, next) => {
    if (req.method === 'GET') res.locals.lq = require('../lib/tprm/list-query').from(req.query, req.baseUrl + req.path.replace(/\/$/, ''));
    next();
  });

  app.use(['/tprm', '/workspaces/:wsId/client-portal/third-party-risk'], (req, res, next) => {
    if (req.method !== 'POST' || !req.body || typeof req.body !== 'object') return next();
    if (typeof req.body._tp_confirm_title !== 'string') { delete req.body._tp_confirmed; return next(); }
    const b = req.body;
    const text = (v, max) => String(v == null ? '' : v).slice(0, max);
    const confirm = {
      title: text(b._tp_confirm_title, 200), body: text(b._tp_confirm_body, 600), action: text(b._tp_confirm_action, 80) || 'Confirm',
      tone: b._tp_confirm_tone === 'problem' ? 'problem' : null,
    };
    const confirmed = b._tp_confirmed === '1';
    for (const k of Object.keys(b)) if (k.startsWith('_tp_confirm')) delete b[k];
    delete b._tp_confirmed;
    if (confirmed) return next();
    const fields = [];
    for (const [name, value] of Object.entries(b)) {
      if (Array.isArray(value)) value.forEach(v => { if (typeof v === 'string') fields.push([name, v]); });
      else if (typeof value === 'string') fields.push([name, value]);
    }
    const ref = String(req.get('Referer') || '');
    let back = req.originalUrl.replace(/\/[^/?#]+(?:\?.*)?$/, '') || '/tprm';
    try { const u = new URL(ref); if (u.host === req.get('host')) back = u.pathname + u.search; } catch (_) {}
    return requireAuth(req, res, () => res.status(200).render('tprm_confirm', { user: req.user, confirm: { ...confirm, url: req.originalUrl, fields, back } }));
  });

  app.get('/tprm', requireAuth, async (req, res) => {
    if (!access.isFirmUser(req.user) || !access.firmCan(req.user, 'tp.view')) {
      return res.status(403).render('error', {
        user: req.user,
        message: 'Third-party risk is available to consulting-team accounts.',
      });
    }
    const clients = await access.listFirmClients(lookup, req.user);
    const pipelineView = await require('../lib/tprm/pipeline').pipeline(lookup, req.user, { query: req.query || {} });
    res.render('tprm_home', {
      hub: await require('../lib/tprm/firm-home').build(lookup, req.user, pipelineView, clients.enabled),
      user: req.user,
      active: 'tprm-portfolio',
      clients: clients.enabled,
      availableClients: access.firmCan(req.user, SWITCH_PERMISSION) ? clients.available : [],
      canViewCriticality: access.firmCan(req.user, 'tp.view'),
      reviewCount: access.firmCan(req.user, 'tp.review')
        ? (await require('../lib/tprm/assessments').reviewQueue(lookup, req.user)).length
          + (await require('../lib/tprm/recommendations').reviewQueue(lookup, req.user)).length
          + (await require('../lib/tprm/decisions').informationRequestQueue(lookup, req.user)).length
          + (await require('../lib/tprm/questionnaire-review').reviewQueue(lookup, req.user)).length
        : access.firmCan(req.user, 'tp.manage')
          ? (await require('../lib/tprm/questionnaire-review').reviewQueue(lookup, req.user)).length : null,
      canAiSettings: access.firmCan(req.user, 'tp.settings'),
      pipelineView,
      waitingLabels: require('../lib/tprm/pipeline').WAITING_LABELS,
    });
  });

  app.post('/tprm/clients/:wsId/enable', requireAuth, async (req, res) => {
    const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId, { requireEnabled: false });
    if (!loaded) return notFound(req, res);
    if (!access.can(req.user, loaded.perms, SWITCH_PERMISSION)) return switchForbidden(req, res);
    const { changed } = await tpSettings.switchOn(db, { user: req.user, perms: loaded.perms, ws: loaded.ws });
    if (changed) {
      await logAction(req.user.id, loaded.ws.id, 'tprm_service_enabled', 'workspace', loaded.ws.id,
        { service: 'third_party_risk', enabled: true, source: 'tprm_area' }, auditCtx(req));
    }
    res.redirect(withToast(`/tprm/clients/${loaded.ws.id}`, changed
      ? 'Third-party risk switched on for this client. Next, tick the rulebooks it is regulated under: Tick rulebooks, below its name.'
      : 'Third-party risk switched on for this client'));
  });

  app.post('/tprm/clients/:wsId/disable', requireAuth, async (req, res) => {
    const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
    if (!loaded) return notFound(req, res);
    if (!access.can(req.user, loaded.perms, SWITCH_PERMISSION)) return switchForbidden(req, res);
    let result;
    try {
      result = await tpSettings.switchOff(db, { user: req.user, perms: loaded.perms, ws: loaded.ws });
    } catch (err) {
      if (err instanceof TprmError && err.status === 409) {
        return res.redirect(withToast(`/tprm/clients/${loaded.ws.id}/settings`, err.message, 'error'));
      }
      throw err;
    }
    if (result.changed) {
      await logAction(req.user.id, loaded.ws.id, 'tprm_service_disabled', 'workspace', loaded.ws.id,
        { service: 'third_party_risk', enabled: false, source: 'tprm_area' }, auditCtx(req));
    }
    res.redirect(withToast('/tprm', 'Third-party risk switched off for this client'));
  });

  app.get('/tprm/clients/:wsId', requireAuth, async (req, res) => {
    const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
    if (!loaded) return notFound(req, res);
    const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
    const regApprovals = await require('../lib/tprm/decisions').approvals(db, loaded.ws);
    const regStages = await require('../lib/tprm/pipeline').stagesForClient(db, loaded.ws.id);
    res.render('tprm_client_home', {
      regTiles: await require('../lib/tprm/register-hub').tiles(db, loaded.ws, { approvals: regApprovals, stages: regStages }),
      user: req.user,
      active: 'tprm-portfolio',
      tpClient: {
        id: loaded.ws.id,
        name: loaded.ws.brand_display_name || loaded.ws.client_name,
        sector: loaded.ws.sector || null,
      },
      tp: tpPlacement,
      registerList: await tpRegister.listThirdParties(db, actor, req.query),
      approvals: regApprovals,
      stages: regStages,
      clientRulebooks: await require('../lib/tprm/rulebooks').currentForClient(db, loaded.ws.id),
      clientRequestsOpen: await require('../lib/tprm/client-requests').list(db, loaded.ws.id, { open: true }),
      regExtras: await require('../lib/tprm/register-hub').extras(db, loaded.ws.id),
      leads: access.can(req.user, loaded.perms, 'tp.manage') ? await require('../lib/tprm/assessments').leadCandidates(db, loaded.ws) : [],
      wsLead: loaded.ws.lead_consultant_id ? ((await db.prepare('SELECT name FROM users WHERE id = ?').get(loaded.ws.lead_consultant_id)) || {}).name || null : null,
      canManage: access.can(req.user, loaded.perms, 'tp.manage'),
      canSettings: access.can(req.user, loaded.perms, 'tp.settings'),
    });
  });

  const PORTAL = '/workspaces/:wsId/client-portal/third-party-risk';
  const decisions = require('../lib/tprm/decisions');
  const clientView = require('../lib/tprm/client-view');
  app.use(PORTAL, (req, res, next) => {
    const q = req.query || {};
    const key = ['error', 'toast', 'notice'].find(k => typeof q[k] === 'string' && q[k]);
    res.locals.cvNotice = key ? { text: String(q[key]).slice(0, 300), kind: key === 'error' || q.toastKind === 'error' ? 'error' : 'ok' } : null;
    next();
  });
  const portalNotFound = (req, res) => res.status(404).render('error', {
    user: req.user, ws: req.workspace,
    message: 'This page does not exist, or it is not available to your account.',
  });
  const portalReady = (req, res) => access.isClientUser(req.user) && res.locals.tpPortalEnabled === true;
  const recUrl = (ws, rid) => `/workspaces/${ws.id}/client-portal/third-party-risk/recommendations/${Number(rid)}`;

  app.get(PORTAL, requireAuth, requireWorkspace, async (req, res) => {
    if (!portalReady(req, res)) return notFound(req, res);
    res.render('tprm_portal_home', {
      user: req.user,
      ws: req.workspace,
      home: await clientView.home(db, req.workspace, req.query || {}, req.user),
      canRequest: await clientView.canEditDetails(db, req.workspace, req.user),
      requestLabels: require('../lib/tprm/client-requests').STATUS_LABELS,
      cv: clientView,
      tp: tpPlacement,
    });
  });

  app.post(`${PORTAL}/findings/:fid/comments`, requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      if (!portalReady(req, res)) return notFound(req, res);
      const base = `/workspaces/${req.workspace.id}/client-portal/third-party-risk`;
      let result;
      try {
        result = await require('../lib/tprm/finding-comments').clientAdd(db, req.workspace, req.user, req.params.fid, req.body || {});
      } catch (err) {
        if (err instanceof TprmError && err.status === 404) return portalNotFound(req, res);
        if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
          const tp = Number(req.body && req.body.third_party_id);
          return res.redirect(withToast(Number.isSafeInteger(tp) && tp > 0 ? `${base}/third-parties/${tp}?tab=issues` : base, err.message, 'error'));
        }
        throw err;
      }
      await logAction(req.user.id, req.workspace.id, 'tprm_finding_client_comment', 'tp_finding', result.findingId, {}, auditCtx(req));
      await require('../lib/tprm/messages').clientFindingComment(db, { workspaceId: req.workspace.id, assessmentId: result.assessmentId, commentId: result.id });
      return res.redirect(withToast(`${base}/third-parties/${result.thirdPartyId}?tab=issues#issue-${result.findingId}`, 'Comment added'));
    } catch (err) { return next(err); }
  });

  app.post(`${PORTAL}/issues/:iid/comments`, requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      if (!portalReady(req, res)) return notFound(req, res);
      const base = `/workspaces/${req.workspace.id}/client-portal/third-party-risk`;
      let result;
      try {
        result = await require('../lib/tprm/issues').clientComment(db, req.workspace, req.user, req.params.iid, req.body || {});
      } catch (err) {
        if (err instanceof TprmError && err.status === 404) return portalNotFound(req, res);
        if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
          const tp = Number(req.body && req.body.third_party_id);
          const back = Number.isSafeInteger(tp) && tp > 0 ? `${base}/third-parties/${tp}?tab=issues` : base;
          return res.redirect(withToast(back, err.message, 'error'));
        }
        throw err;
      }
      await logAction(req.user.id, req.workspace.id, 'tprm_issue_client_comment', 'tp_issue', result.issueId, {}, auditCtx(req));
      await require('../lib/tprm/messages').clientCommented(db, { workspaceId: req.workspace.id, assessmentId: result.assessmentId, issueId: result.issueId });
      return res.redirect(withToast(`${base}/third-parties/${result.thirdPartyId}?tab=issues#issue-${result.findingId}`, 'Comment added'));
    } catch (err) { return next(err); }
  });

  app.get(`${PORTAL}/third-parties/:tid`, requireAuth, requireWorkspace, async (req, res) => {
    if (!portalReady(req, res)) return notFound(req, res);
    const party = await clientView.thirdParty(db, req.workspace, req.params.tid);
    if (!party) return portalNotFound(req, res);
    const tab = ['overview', 'scoping', 'reviews', 'issues', 'conditions', 'documents', 'contracts'].includes(String(req.query.tab)) ? String(req.query.tab) : 'overview';
    const canEdit = await clientView.canEditDetails(db, req.workspace, req.user);
    res.render('tprm_portal_party', { user: req.user, ws: req.workspace, party, tab, tp: tpPlacement, canEdit,
      clientPeople: canEdit ? await tpRegister.clientPeople(db, req.workspace.id) : [], editing: req.query.edit === 'details' && canEdit });
  });

  const clientRequests = require('../lib/tprm/client-requests');
  async function renderRequestForm(req, res, { values = {}, errors = [], status = 200 } = {}) {
    const model = await clientRequests.modelFor(db, req.workspace);
    return res.status(status).render('tprm_portal_request', {
      user: req.user, ws: req.workspace, values, errors,
      questions: clientRequests.questionsOf(model), people: await tpRegister.clientPeople(db, req.workspace.id),
    });
  }

  app.get(`${PORTAL}/requests/new`, requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      if (!portalReady(req, res)) return notFound(req, res);
      if (!(await clientView.canEditDetails(db, req.workspace, req.user))) {
        return res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/third-party-risk?tab=requests`, 'Your role does not allow requesting a new third party.', 'error'));
      }
      return await renderRequestForm(req, res, { values: { owner_user_id: String(req.user.id) } });
    } catch (err) { return next(err); }
  });

  app.post(`${PORTAL}/requests`, requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      if (!portalReady(req, res)) return notFound(req, res);
      const back = `/workspaces/${req.workspace.id}/client-portal/third-party-risk?tab=requests`;
      if (!(await clientView.canEditDetails(db, req.workspace, req.user))) return res.redirect(withToast(back, 'Your role does not allow requesting a new third party.', 'error'));
      try {
        const r = await clientRequests.submit(db, req.workspace, req.user, req.body || {});
        await logAction(req.user.id, req.workspace.id, 'tprm_client_request_submitted', 'tp_client_request', r.id, {}, auditCtx(req));
        await require('../lib/tprm/messages').clientRequested(db, { workspaceId: req.workspace.id, requestId: r.id });
        return res.redirect(withToast(back, `Request for ${r.name} sent to your consultants`));
      } catch (err) {
        if (err instanceof TprmError && err.status === 400) return await renderRequestForm(req, res, { values: req.body || {}, errors: err.errors || [err.message], status: 400 });
        throw err;
      }
    } catch (err) { return next(err); }
  });

  app.post(`${PORTAL}/requests/:rid/withdraw`, requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      if (!portalReady(req, res)) return notFound(req, res);
      const back = `/workspaces/${req.workspace.id}/client-portal/third-party-risk?tab=requests`;
      if (!(await clientView.canEditDetails(db, req.workspace, req.user))) return res.redirect(withToast(back, 'Your role does not allow this.', 'error'));
      try {
        await clientRequests.withdraw(db, req.workspace, req.user, req.params.rid, req.body || {});
        await logAction(req.user.id, req.workspace.id, 'tprm_client_request_withdrawn', 'tp_client_request', Number(req.params.rid) || 0, {}, auditCtx(req));
        return res.redirect(withToast(back, 'Request withdrawn'));
      } catch (err) {
        if (err instanceof TprmError && err.status === 404) return portalNotFound(req, res);
        if (err instanceof TprmError && err.status === 409) return res.redirect(withToast(back, err.message, 'error'));
        throw err;
      }
    } catch (err) { return next(err); }
  });

  app.post(`${PORTAL}/third-parties/:tid/details`, requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      if (!portalReady(req, res)) return notFound(req, res);
      const base = `/workspaces/${req.workspace.id}/client-portal/third-party-risk/third-parties/${Number(req.params.tid) || 0}`;
      if (!(await clientView.canEditDetails(db, req.workspace, req.user))) {
        return res.redirect(withToast(base, 'Your role does not allow changing these details.', 'error'));
      }
      try {
        const r = await tpRegister.setClientDetails(db, req.workspace, req.user, req.params.tid, req.body || {});
        if (!r.unchanged) await logAction(req.user.id, req.workspace.id, 'tprm_client_details_changed', 'tp_third_party', r.thirdPartyId, {}, auditCtx(req));
        return res.redirect(withToast(base, r.unchanged ? 'No changes to save' : 'Details saved'));
      } catch (err) {
        if (err instanceof TprmError && err.status === 404) return portalNotFound(req, res);
        if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return res.redirect(withToast(`${base}?edit=details`, err.message, 'error'));
        throw err;
      }
    } catch (err) { return next(err); }
  });

  app.get(`${PORTAL}/concentration`, requireAuth, requireWorkspace, async (req, res) => {
    if (!portalReady(req, res)) return notFound(req, res);
    const concentration = require('../lib/tprm/concentration');
    const summary = await concentration.forPortal(db, { user: req.user, perms: res.locals.userPerms, ws: req.workspace });
    if (!summary) return portalNotFound(req, res);
    res.render('tprm_portal_concentration', {
      user: req.user, ws: req.workspace, active: 'client-portal', portalView: 'third-party-risk', summary, C: concentration,
    });
  });

  async function renderRecommendation(req, res, { errors = [], values = {}, status = 200 } = {}) {
    const page = await decisions.portalRecommendation(db, req.workspace, req.params.rid, req.user);
    if (!page) return portalNotFound(req, res);
    return res.status(status).render('tprm_portal_recommendation', {
      user: req.user,
      ws: req.workspace,
      active: 'client-portal',
      portalView: 'third-party-risk',
      page, errors, values,
      tp: tpPlacement,
      rec: require('../lib/tprm/recommendations'),
      at: require('../lib/tprm/assessments'),
      fd: require('../lib/tprm/findings'),
      D: decisions,
    });
  }

  app.get(`${PORTAL}/recommendations/:rid`, requireAuth, requireWorkspace, async (req, res) => {
    if (!portalReady(req, res)) return notFound(req, res);
    return renderRecommendation(req, res);
  });

  app.post(`${PORTAL}/recommendations/:rid/decision`, requireAuth, requireWorkspace, async (req, res, next) => {
    if (!access.isClientUser(req.user)) {
      return res.status(403).render('error', {
        user: req.user,
        message: 'Firm users, managers included, cannot record a client decision. Only the client decision owner named on the assessment records it, in the client portal.',
      });
    }
    if (!portalReady(req, res)) return notFound(req, res);
    const actor = { user: req.user, perms: res.locals.userPerms, ws: req.workspace };
    try {
      const result = await decisions.recordDecision(db, actor, req.params.rid, req.body);
      await require('../lib/tprm/messages').clientDecided(db, { workspaceId: req.workspace.id, assessmentId: Number(result.decision.assessment_id), decisionId: result.decision.id });
      await logAction(req.user.id, req.workspace.id, 'tprm_client_decision_recorded', 'tp_recommendation', Number(req.params.rid),
        { outcome: result.decision.outcome, diverges: result.decision.diverges }, auditCtx(req));
      const message = result.decision.outcome === decisions.MORE_INFORMATION
        ? 'Your request for more information has been sent to your consultants'
        : 'Your decision has been recorded';
      return res.redirect(withToast(recUrl(req.workspace, req.params.rid), message));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderRecommendation(req, res, { errors: err.errors || [err.message], values: req.body, status: 400 });
      }
      if (err instanceof TprmError) {
        return res.status(err.status).render('error', { user: req.user, ws: req.workspace, message: err.message });
      }
      return next(err);
    }
  });

  app.get(`${PORTAL}/recommendations/:rid/evidence/:eid/download`, requireAuth, requireWorkspace, async (req, res) => {
    if (!portalReady(req, res)) return notFound(req, res);
    const file = await decisions.portalEvidenceFile(db, req.workspace, req.params.rid, req.params.eid);
    if (!file) return portalNotFound(req, res);
    const target = resolveUploadPath(file.stored_path, req.workspace.firm_id);
    if (!target || !fs.existsSync(target)) return portalNotFound(req, res);
    await logAction(req.user.id, req.workspace.id, 'tprm_client_download_released_evidence', 'tp_evidence', Number(file.id),
      { recommendation_id: Number(req.params.rid) }, auditCtx(req));
    res.set('X-Content-Type-Options', 'nosniff');
    return res.download(target, file.original_name);
  });
}

module.exports = { register, SWITCH_PERMISSION };
