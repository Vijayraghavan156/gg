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
    if (!result.created) return res.redirect(withToast(back, 'Brevis is already reviewing this assessment, or about to'));
    if (result.overLimit) return res.redirect(withToast(back, 'Brevis is reviewing past the limit; your reason is recorded. Reload the page in a minute to see its suggestions'));
    return res.redirect(withToast(back, 'Brevis is reviewing. Reload the page in a minute to see its suggestions'));
  }), { permission: 'tp.manage' }));

  const FILTER_NAMES = require('../lib/tprm/questionnaire-review').FILTERS;
  const wantsJson = req => /application\/json/.test(String(req.get('accept') || ''));
  const answerBack = (req, back) => {
    const answerId = Number((req.body || {}).answer_id);
    if (!Number.isSafeInteger(answerId) || answerId < 1) return back;
    const f = String((req.body || {}).answers_filter || '');
    return back.replace('#ai-review', `${FILTER_NAMES.includes(f) ? `&answers=${f}` : ''}#answer-${answerId}`);
  };
  const decided = (req, res, back, message, tone) => {
    if (wantsJson(req)) return res.status(tone === 'error' ? 400 : 200).json({ ok: tone !== 'error', message });
    return res.redirect(withToast(answerBack(req, back), message, tone));
  };
  const decideStep = fn => step(async (req, res, actor, thirdParty, back) => {
    try {
      return await fn(req, res, actor, thirdParty, back);
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return decided(req, res, back, err.message, 'error');
      throw err;
    }
  });

  app.post(`${BASE}/ai-suggestions/:sid/accept`, requireAuth, handler(decideStep(async (req, res, actor, thirdParty, back) => {
    const { finding, conclusion } = await aiReview.accept(db, actor, thirdParty.id, req.params.aid, req.params.sid);
    if (!finding) return decided(req, res, back, `Reviewer conclusion set from Brevis's suggestion: ${aiReview.CONCLUSION_LABELS[conclusion]}`);
    return decided(req, res, back, `Finding added from Brevis's suggestion: ${finding.title}`);
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/ai-suggestions/:sid/reject`, requireAuth, handler(decideStep(async (req, res, actor, thirdParty, back) => {
    await aiReview.reject(db, actor, thirdParty.id, req.params.aid, req.params.sid, req.body);
    return decided(req, res, back, 'Brevis suggestion rejected');
  }), { permission: 'tp.manage' }));
}

module.exports = { register: registerRoutes };
