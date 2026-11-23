'use strict';

const { withToast } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const register = require('../lib/tprm/register');
const assessments = require('../lib/tprm/assessments');
const criticality = require('../lib/tprm/criticality');
const clientSettings = require('../lib/tprm/client-settings');
const placement = require('../lib/tprm/placement');
const recommendations = require('../lib/tprm/recommendations');
const decisions = require('../lib/tprm/decisions');
const questionnaires = require('../lib/tprm/questionnaires');
const aiReview = require('../lib/tprm/ai-review');
const { TprmError } = require('../lib/tprm/errors');

const NOT_FOUND = 'This third-party risk client does not exist, or it is not available to your account.';
const BASE = '/tprm/clients/:wsId/third-parties/:tpId/assessments';

function clientView(ws) {
  return { id: ws.id, name: ws.brand_display_name || ws.client_name, sector: ws.sector || null };
}

function registerRoutes(app, deps) {
  const { db, requireAuth, getWorkspace, permissionsFor, listWorkspaces } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };
  const tpUrl = (actor, tpId) => `/tprm/clients/${actor.ws.id}/third-parties/${tpId}`;
  const aUrl = (actor, a) => `${tpUrl(actor, a.third_party_id)}/assessments/${a.id}`;

  const FORBIDDEN = {
    'tp.manage': 'Your role does not allow changes to this client\'s assessments.',
    'tp.review': 'Only a senior consultant or a manager can confirm or send back a proposed tier.',
  };

  function handler(fn, { permission = 'tp.view' } = {}) {
    return async (req, res, next) => {
      try {
        const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
        if (!loaded) return res.status(404).render('error', { user: req.user, message: NOT_FOUND });
        const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
        if (permission !== 'tp.view' && !access.can(req.user, actor.perms, permission)) {
          return res.status(403).render('error', { user: req.user, message: FORBIDDEN[permission] });
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

  async function renderAssessment(req, res, actor, thirdParty, assessment, { form = null, errors = [], status = 200, newLink = null } = {}) {
    const [model, services, settings, history, owners] = [
      await assessments.modelOf(db, assessment),
      await register.listServices(db, actor, thirdParty.id),
      await clientSettings.get(db, actor.ws.id),
      await assessments.assessmentEvents(db, actor, assessment, 5000),
      await assessments.decisionOwnerCandidates(db, actor.ws.id),
    ];
    const activeModel = await criticality.getActiveModel(db, Number(actor.ws.firm_id));
    const values = form || {
      services: (assessment.services_in_scope || []).map(s => String(s.id)),
      answers: assessment.answers || {},
      designation_choice: assessment.client_designation_choice || '',
      override_direction: assessment.client_designation_choice === 'keep_client_designation' ? 'none' : assessment.override_direction,
      override_tier: assessment.client_designation_choice === 'keep_client_designation' ? '' : (assessment.override_direction !== 'none' ? assessment.final_tier : ''),
      override_reason: assessment.client_designation_choice === 'keep_client_designation' ? '' : (assessment.override_reason || ''),
      override_preset: assessment.client_designation_used && assessment.client_designation_choice !== 'keep_client_designation' ? 'client_designation' : '',
    };
    const preview = assessments.evaluate({ model, assessment, thirdParty, services, settings, user: req.user, input: values, checkAuthority: false });
    const canManage = access.can(req.user, actor.perms, 'tp.manage');
    const canReview = access.can(req.user, actor.perms, 'tp.review');
    const questionnairePanel = await questionnaires.panel(db, actor, assessment, { answersFilter: req.query && req.query.answers, raise: req.query && req.query.raise });
    const recommendation = await recommendations.pageData(db, actor, assessment, { lookup });
    const decisionPanel = await decisions.firmPanel(db, actor, assessment);
    const selfApproveTiers = (await require('../lib/tprm/two-person').settingsFor(db, actor.ws.firm_id)).selfApproveTiers;
    const isProposer = Number(assessment.proposed_by) === Number(req.user.id);
    const tpf = res.locals.tpf || require('../lib/tprm/format').forZone('UTC');
    const statusLine = require('../lib/tprm/status-line').statusLine({
      assessment, thirdParty, qp: questionnairePanel, rd: recommendation, dp: decisionPanel,
      viewer: { canManage, canReview, isManager: access.isManager(req.user), isProposer, selfApproveTiers },
      base: aUrl(actor, assessment), tierLabel: k => (k ? placement.TIER_LABELS[k] : ''), day: d => tpf.day(d),
    });
    const historyView = require('../lib/tprm/history').entries(history, {
      tierLabel: k => placement.TIER_LABELS[k] || k, conclusionLabels: require('../lib/tprm/questionnaire-review').CONCLUSION_LABELS,
      q: req.query && typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '',
    });
    return res.status(status).render('tprm_assessment', {
      statusLine,
      historyView,
      historyQuery: req.query && typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '',
      user: req.user,
      active: 'tprm-portfolio',
      tpClient: clientView(actor.ws),
      tp: placement,
      at: assessments,
      canManage,
      canSettings: access.can(req.user, actor.perms, 'tp.settings'),
      canReview,
      isManager: access.isManager(req.user),
      isProposer,
      selfApproveTiers,
      thirdParty, assessment, model, services, history, owners, values, errors, preview,
      modelIsActive: !!activeModel && Number(activeModel.id) === Number(model.id),
      clientSaysCritical: assessments.clientSaysCritical(thirdParty, settings),
      questionnairePanel,
      newLink,
      evidencePanel: await require('../lib/tprm/evidence').panel(db, actor, assessment),
      issuesPanel: {
        list: await require('../lib/tprm/issues').forAssessment(db, actor.ws.id, assessment.id),
        labels: require('../lib/tprm/issues').STATUS_LABELS,
        canManage: canManage && !['cancelled', 'completed'].includes(assessment.status),
      },
      recommendation,
      canCancel: canManage && await assessments.canCancel(db, actor, assessment),
      decisionPanel,
      decisionEventLabels: decisions.EVENT_LABELS,
      aiPanel: await aiReview.panel(db, actor, assessment),
      aiEventLabels: aiReview.EVENT_LABELS,
      step: req.query && typeof req.query.step === 'string' ? req.query.step : (req.query && req.query.answers ? 'review' : null),
    });
  }

  app.post('/tprm/clients/:wsId/third-parties/:tpId/assessments', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    try {
      const assessment = await assessments.start(db, actor, thirdParty.id);
      return res.redirect(withToast(aUrl(actor, assessment), `${assessments.TYPE_LABELS[assessment.type]} started`));
    } catch (err) {
      if (err instanceof TprmError && err.status === 409) {
        const target = err.openAssessmentId ? `${tpUrl(actor, thirdParty.id)}/assessments/${err.openAssessmentId}` : tpUrl(actor, thirdParty.id);
        return res.redirect(withToast(target, err.message, 'error'));
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.get(`${BASE}/:aid`, requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
    return renderAssessment(req, res, actor, thirdParty, assessment);
  }));

  app.post(`${BASE}/:aid/scope`, requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const proposing = req.body.intent === 'propose';
    try {
      if (proposing) {
        const { assessment } = await assessments.propose(db, actor, thirdParty.id, req.params.aid, req.body);
        return res.redirect(withToast(aUrl(actor, assessment), 'Tier proposed. A second person confirms it from the review queue'));
      }
      const result = await assessments.saveScope(db, actor, thirdParty.id, req.params.aid, req.body);
      return res.redirect(withToast(aUrl(actor, result.assessment), result.unchanged ? 'No changes to save' : 'Scope saved'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
        return renderAssessment(req, res, actor, thirdParty, assessment, { form: req.body, errors: err.errors || [err.message], status: 400 });
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/:aid/confirm`, requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    let assessment;
    try {
      assessment = await assessments.confirm(db, actor, thirdParty.id, req.params.aid, req.body);
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return res.redirect(withToast(aUrl(actor, { third_party_id: thirdParty.id, id: Number(req.params.aid) }), err.message, 'error'));
      }
      throw err;
    }
    return res.redirect(withToast(aUrl(actor, assessment), `Tier confirmed: ${placement.TIER_LABELS[assessment.final_tier]}${assessment.self_approval_reason ? ' (self-approved, the reason is recorded)' : ''}`));
  }, { permission: 'tp.review' }));

  app.post(`${BASE}/:aid/return`, requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    try {
      const assessment = await assessments.sendBack(db, actor, thirdParty.id, req.params.aid, req.body);
      return res.redirect(withToast(aUrl(actor, assessment), 'Sent back to the consultant'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return res.redirect(withToast(`${tpUrl(actor, thirdParty.id)}/assessments/${Number(req.params.aid)}`, err.message, 'error'));
      }
      throw err;
    }
  }, { permission: 'tp.review' }));

  app.post(`${BASE}/:aid/cancel`, requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    try {
      await assessments.cancel(db, actor, thirdParty.id, req.params.aid, req.body);
      return res.redirect(withToast(tpUrl(actor, thirdParty.id), 'Assessment cancelled'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return res.redirect(withToast(`${tpUrl(actor, thirdParty.id)}/assessments/${Number(req.params.aid)}`, err.message, 'error'));
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/:aid/details`, requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    try {
      const result = await assessments.updateDetails(db, actor, thirdParty.id, req.params.aid, req.body);
      return res.redirect(withToast(aUrl(actor, result.assessment), result.unchanged ? 'No changes to save' : 'Assessment details saved'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return res.redirect(withToast(`${tpUrl(actor, thirdParty.id)}/assessments/${Number(req.params.aid)}`, err.message, 'error'));
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  require('./tprm-questionnaires').register(app, { db, requireAuth, handler, renderAssessment });
  require('./tprm-ai-review').register(app, { db, requireAuth, handler });

  app.get('/tprm/review', requireAuth, async (req, res) => {
    const reviewer = access.isFirmUser(req.user) && access.firmCan(req.user, 'tp.review');
    if (!access.isFirmUser(req.user) || (!reviewer && !access.firmCan(req.user, 'tp.manage'))) {
      return res.status(403).render('error', {
        user: req.user,
        message: 'The review queue is for consultants, senior consultants and managers.',
      });
    }
    const readOnly = !reviewer;
    res.render('tprm_review', {
      user: req.user,
      active: 'tprm-portfolio',
      tp: placement,
      at: assessments,
      readOnly,
      queue: await assessments.reviewQueue(lookup, req.user, { readOnly }),
      selfApproved: await assessments.selfApprovedRecently(lookup, req.user),
      recommendationQueue: await recommendations.reviewQueue(lookup, req.user, { readOnly }),
      informationQueue: readOnly ? undefined : await decisions.informationRequestQueue(lookup, req.user),
      questionnaireQueue: await require('../lib/tprm/questionnaire-review').reviewQueue(lookup, req.user),
      qStatusLabels: questionnaires.STATUS_LABELS,
      rec: recommendations,
    });
  });
}

module.exports = { register: registerRoutes };
