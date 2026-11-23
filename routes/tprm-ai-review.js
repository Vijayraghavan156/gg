'use strict';

const { withToast } = require('../lib/http-helpers');
const register = require('../lib/tprm/register');
const aiReview = require('../lib/tprm/ai-review');
const { TprmError } = require('../lib/tprm/errors');

const BASE = '/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid';

function registerRoutes(app, { db, requireAuth, handler }) {
  const panelUrl = (actor, tpId, aid) => `/tprm/clients/${actor.ws.id}/third-parties/${Number(tpId)}/assessments/${Number(aid)}?step=review#ai-review`;

  const step = fn => async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const back = panelUrl(actor, thirdParty.id, req.params.aid);
    try {
      return await fn(req, res, actor, thirdParty, back);
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return res.redirect(withToast(back, err.message, 'error'));
      throw err;
    }
  };

  app.post(`${BASE}/ai-review`, requireAuth, handler(step(async (req, res, actor, thirdParty, back) => {
    const result = await aiReview.requestRun(db, actor, thirdParty.id, req.params.aid, req.body);
    if (result.notConfigured) return res.redirect(withToast(back, `${aiReview.NOT_CONFIGURED} The run was recorded; nothing was sent`));
    if (!result.created) return res.redirect(withToast(back, 'An AI review is already waiting or running for this assessment'));
    if (result.overLimit) return res.redirect(withToast(back, 'AI review requested past the limit; your reason is recorded. Reload the page in a minute to see its suggestions'));
    return res.redirect(withToast(back, 'AI review requested. Reload the page in a minute to see its suggestions'));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/ai-suggestions/:sid/accept`, requireAuth, handler(step(async (req, res, actor, thirdParty, back) => {
    const { finding, conclusion } = await aiReview.accept(db, actor, thirdParty.id, req.params.aid, req.params.sid);
    if (!finding) return res.redirect(withToast(back, `Reviewer conclusion set from the AI suggestion: ${aiReview.CONCLUSION_LABELS[conclusion]}`));
    return res.redirect(withToast(back, `Finding added from the AI suggestion: ${finding.title}`));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/ai-suggestions/:sid/reject`, requireAuth, handler(step(async (req, res, actor, thirdParty, back) => {
    await aiReview.reject(db, actor, thirdParty.id, req.params.aid, req.params.sid, req.body);
    return res.redirect(withToast(back, 'AI suggestion rejected'));
  }), { permission: 'tp.manage' }));
}

module.exports = { register: registerRoutes };
