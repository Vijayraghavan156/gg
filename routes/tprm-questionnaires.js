'use strict';

const { withToast } = require('../lib/http-helpers');
const register = require('../lib/tprm/register');
const assessments = require('../lib/tprm/assessments');
const questionnaires = require('../lib/tprm/questionnaires');
const review = require('../lib/tprm/questionnaire-review');
const reports = require('../lib/tprm/assurance-reports');
const answerRules = require('../lib/tprm/answer-rules');
const { TprmError } = require('../lib/tprm/errors');
const tpf = require('../lib/tprm/format');

const BASE = '/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid/questionnaire';

function registerRoutes(app, { db, requireAuth, handler, renderAssessment }) {
  const stepUrl = (actor, tpId, aid) => `/tprm/clients/${actor.ws.id}/third-parties/${Number(tpId)}/assessments/${Number(aid)}?step=questionnaire#questionnaire`;
  const answersUrl = (actor, tpId, aid, body, anchor = 'questionnaire-answers') => {
    const filter = review.FILTERS.includes(String(body && body.answers_filter)) ? `&answers=${body.answers_filter}` : '';
    const stepKey = anchor === 'questionnaire' ? 'questionnaire' : 'review';
    return `/tprm/clients/${actor.ws.id}/third-parties/${Number(tpId)}/assessments/${Number(aid)}?step=${stepKey}${filter}#${anchor}`;
  };

  const step = fn => async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const back = stepUrl(actor, thirdParty.id, req.params.aid);
    try {
      return await fn(req, res, actor, thirdParty, back);
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return res.redirect(withToast(back, err.message, 'error'));
      throw err;
    }
  };

  app.post(BASE, requireAuth, handler(step(async (req, res, actor, thirdParty, back) => {
    const q = await questionnaires.prepare(db, actor, thirdParty.id, req.params.aid, req.body);
    return res.redirect(withToast(back, `Questionnaire prepared: ${q.vendor_question_count} questions for the third party`));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/modules`, requireAuth, handler(step(async (req, res, actor, thirdParty, back) => {
    const result = await questionnaires.changeModule(db, actor, thirdParty.id, req.params.aid, req.body);
    return res.redirect(withToast(back, `${result.module} ${result.op === 'add' ? 'added' : 'removed'}: `
      + `${result.questionnaire.vendor_question_count} questions for the third party`));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/links`, requireAuth, handler(step(async (req, res, actor, thirdParty) => {
    const created = await questionnaires.createLink(db, actor, thirdParty.id, req.params.aid, req.body);
    let emailed = null;
    if (req.body.send_email === '1') emailed = await questionnaires.emailLink(db, actor, created.assessment, created.request, created.url);
    const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
    return renderAssessment(req, res, actor, thirdParty, assessment, {
      newLink: {
        url: created.url,
        recipientName: created.request.recipient_name,
        recipientEmail: created.request.recipient_email,
        expiresAt: created.request.expires_at,
        replaced: created.replaced.length > 0,
        emailed,
      },
    });
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/not-returned`, requireAuth, handler(step(async (req, res, actor, thirdParty, back) => {
    const result = await questionnaires.closeNotReturned(db, actor, thirdParty.id, req.params.aid, req.body);
    return res.redirect(withToast(back, `Questionnaire closed as not returned${result.revoked.length ? ': the link no longer works' : ''}`));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/remind`, requireAuth, handler(step(async (req, res, actor, thirdParty, back) => {
    const a = await require('../lib/tprm/assessments').getAssessment(db, actor, thirdParty.id, req.params.aid);
    const r = await require('../lib/tprm/messages').manualReminder(db, { workspaceId: actor.ws.id, assessmentId: a.id });
    return res.redirect(withToast(back, r.sent ? `Reminder sent to ${r.recipient || 'the third party'}` : `No reminder sent: ${r.reason}`, r.sent ? undefined : 'error'));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/links/:lid/revoke`, requireAuth, handler(step(async (req, res, actor, thirdParty, back) => {
    await questionnaires.revokeLink(db, actor, thirdParty.id, req.params.aid, req.params.lid, req.body);
    return res.redirect(withToast(back, 'Link revoked: it no longer opens the questionnaire'));
  }), { permission: 'tp.manage' }));

  const json = fn => async (req, res, actor) => {
    res.set('Cache-Control', 'no-store');
    try {
      const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
      return res.json({ ok: true, ...(await fn(req, actor, thirdParty)) });
    } catch (err) {
      if (err instanceof TprmError) return res.status(err.status).json({ ok: false, error: err.message });
      throw err;
    }
  };
  const acceptedMessage = r => `${r.count} plain answer${r.count === 1 ? '' : 's'} accepted as Satisfactory (${r.scope})`;

  app.post(`${BASE}/answers/:ansId/conclusion.json`, requireAuth, handler(json(async (req, actor, thirdParty) => {
    const result = await review.setConclusion(db, actor, thirdParty.id, req.params.aid, req.params.ansId, req.body || {});
    const state = await review.reviewState(db, actor, result.questionnaireId);
    const a = result.answer;
    return {
      unchanged: !!result.unchanged,
      message: result.unchanged ? 'No changes to save' : `Saved: ${review.CONCLUSION_LABELS[a.review_conclusion]}`,
      answer: { id: Number(a.id), question_id: a.question_id, row_version: Number(a.row_version), conclusion: a.review_conclusion,
        conclusion_label: review.CONCLUSION_LABELS[a.review_conclusion], comment: a.review_comment || '',
        reviewed_line: result.unchanged ? null : `${actor.user.name || actor.user.email}, ${tpf.day(new Date())}` },
      ...state,
    };
  })));

  app.post(`${BASE}/accept-plain.json`, requireAuth, handler(json(async (req, actor, thirdParty) => {
    const result = await review.acceptPlain(db, actor, thirdParty.id, req.params.aid, req.body || {});
    return { accepted: result.count, scope: result.scope, message: acceptedMessage(result) };
  })));

  app.post(`${BASE}/accept-plain`, requireAuth, handler(step(async (req, res, actor, thirdParty) => {
    const back = answersUrl(actor, thirdParty.id, req.params.aid, req.body);
    try {
      return res.redirect(withToast(back, acceptedMessage(await review.acceptPlain(db, actor, thirdParty.id, req.params.aid, req.body))));
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return res.redirect(withToast(back, err.message, 'error'));
      throw err;
    }
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/answers/:ansId/review`, requireAuth, handler(step(async (req, res, actor, thirdParty) => {
    const result = await review.setConclusion(db, actor, thirdParty.id, req.params.aid, req.params.ansId, req.body);
    return res.redirect(withToast(answersUrl(actor, thirdParty.id, req.params.aid, req.body, `answer-${Number(req.params.ansId)}`),
      result.unchanged ? 'No changes to save' : `Conclusion saved for ${result.answer.question_id}: ${review.CONCLUSION_LABELS[result.answer.review_conclusion]}`));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/clarifications`, requireAuth, handler(step(async (req, res, actor, thirdParty) => {
    const result = await review.askClarification(db, actor, thirdParty.id, req.params.aid, req.body);
    if (!result.needsLink) await require('../lib/tprm/messages').clarificationAsked(db, { workspaceId: actor.ws.id, assessmentId: Number(req.params.aid), clarificationId: result.clarificationId });
    return res.redirect(withToast(answersUrl(actor, thirdParty.id, req.params.aid, req.body, result.needsLink ? 'questionnaire' : 'questionnaire-answers'),
      result.needsLink
        ? `Clarification on ${result.questionId} recorded. The submitted link is used up: issue a new link so the third party can answer it`
        : `Clarification on ${result.questionId} recorded: the third party sees it on its link`));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/clarifications/:cid/close`, requireAuth, handler(step(async (req, res, actor, thirdParty) => {
    const result = await review.closeClarification(db, actor, thirdParty.id, req.params.aid, req.params.cid, req.body);
    return res.redirect(withToast(answersUrl(actor, thirdParty.id, req.params.aid, req.body), `Clarification on ${result.questionId} closed`));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/reports/:rid/check`, requireAuth, handler(step(async (req, res, actor, thirdParty) => {
    const result = await reports.checkReport(db, actor, thirdParty.id, req.params.aid, req.params.rid, req.body);
    const label = answerRules.KIND_LABELS[result.report.kind];
    const raised = result.raised.length;
    const asked = raised ? ` Evidence is asked for again on ${raised} question${raised === 1 ? '' : 's'}`
      + (result.needsLink ? ': issue a new link so the third party can answer.' : ': the third party sees it on its link.') : '';
    return res.redirect(withToast(answersUrl(actor, thirdParty.id, req.params.aid, req.body, raised && result.needsLink ? 'questionnaire' : 'questionnaire-reports'),
      `${label} ${result.status}.${asked}`));
  }), { permission: 'tp.manage' }));

  app.post(`${BASE}/close`, requireAuth, handler(step(async (req, res, actor, thirdParty, back) => {
    await review.closeReview(db, actor, thirdParty.id, req.params.aid, req.body);
    return res.redirect(withToast(back, 'Review of the answers closed'));
  }), { permission: 'tp.manage' }));
}

module.exports = { register: registerRoutes };
