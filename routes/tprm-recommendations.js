'use strict';

const { withToast } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const register = require('../lib/tprm/register');
const recommendations = require('../lib/tprm/recommendations');
const { TprmError } = require('../lib/tprm/errors');

const NOT_FOUND = 'This third-party risk client does not exist, or it is not available to your account.';
const BASE = '/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid/recommendations';

function registerRoutes(app, deps) {
  const { db, requireAuth, getWorkspace, permissionsFor, listWorkspaces } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };
  const stepUrl = (actor, tpId, aid) => `/tprm/clients/${actor.ws.id}/third-parties/${Number(tpId)}/assessments/${Number(aid)}?step=recommendation#recommendation`;

  const FORBIDDEN = {
    'tp.manage': 'Your role does not allow changes to this client\'s recommendations.',
    'tp.review': 'Only a senior consultant or a manager can review and issue a recommendation.',
  };

  function handler(fn, { permission }) {
    return async (req, res, next) => {
      try {
        const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
        if (!loaded) return res.status(404).render('error', { user: req.user, message: NOT_FOUND });
        const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
        if (!access.can(req.user, actor.perms, permission)) {
          return res.status(403).render('error', { user: req.user, message: FORBIDDEN[permission] });
        }
        const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
        const back = stepUrl(actor, thirdParty.id, req.params.aid);
        try {
          return await fn(req, res, actor, thirdParty, back);
        } catch (err) {
          if (err instanceof TprmError && err.status === 400) return res.redirect(withToast(back, err.message, 'error'));
          throw err;
        }
      } catch (err) {
        if (err instanceof TprmError) {
          return res.status(err.status >= 400 && err.status < 600 ? err.status : 500).render('error', { user: req.user, message: err.message });
        }
        return next(err);
      }
    };
  }

  app.post(BASE, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    const rec = await recommendations.createDraft(db, actor, thirdParty.id, req.params.aid, req.body);
    return res.redirect(withToast(back, `Recommendation version ${rec.version} started`));
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/new-version`, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    const rec = await recommendations.startNewVersion(db, actor, thirdParty.id, req.params.aid, req.body);
    return res.redirect(withToast(back, `Revised recommendation started: version ${rec.version} (draft)`));
  }, { permission: 'tp.manage' }));

  const { simpleHandler } = require('./form-drafts');
  async function draftTarget(req) {
    const failure = require('../lib/form-drafts').failure;
    const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId, { permission: 'tp.manage' });
    const rid = Number(req.params.rid);
    const record = loaded && Number.isSafeInteger(rid) && rid > 0 ? await recommendations.draftRecord(db, loaded.ws.id, rid) : null;
    if (!record) throw failure('This draft is not available to your account.', 403);
    return { workspaceId: loaded.ws.id, actorId: req.user.id, kind: 'tprm-recommendation', recordId: String(record.id), contextKey: '',
      recordVersion: record.row_version ?? 0, encryptionEnabled: !!loaded.ws.encryption_enabled };
  }
  const DRAFTS = '/tprm/clients/:wsId/form-drafts/tprm-recommendation/:rid';
  app.get(DRAFTS, requireAuth, simpleHandler(db, draftTarget, 'get'));
  app.put(DRAFTS, requireAuth, simpleHandler(db, draftTarget, 'save'));
  app.delete(DRAFTS, requireAuth, simpleHandler(db, draftTarget, 'discard'));

  app.post(`${BASE}/:rid`, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    const saved = await recommendations.saveDraft(db, actor, thirdParty.id, req.params.aid, req.params.rid, req.body);
    await require('../lib/form-drafts').consume(db, { workspaceId: actor.ws.id, actorId: req.user.id, kind: 'tprm-recommendation', recordId: String(req.params.rid), contextKey: '' });
    const converted = saved.synced && saved.synced.converted
      ? ' The recommendation is now "with conditions": a material service in scope has no complete exit plan, so an automatic client condition was added.'
      : saved.synced && saved.synced.changed ? ' The automatic exit plan conditions were updated.' : '';
    if (req.body.intent !== 'submit' || converted) {
      return res.redirect(withToast(back, `${saved.unchanged ? 'No changes to save' : 'Draft saved'}${converted ? `.${converted}${req.body.intent === 'submit' ? ' Check it, then submit.' : ''}` : ''}`,
        converted ? 'warn' : undefined));
    }
    try {
      await recommendations.submit(db, actor, thirdParty.id, req.params.aid, req.params.rid,
        { row_version: saved.recommendation.row_version });
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return res.redirect(withToast(back, `${saved.unchanged ? 'Not submitted' : 'Draft saved but not submitted'}: ${err.message}`, 'error'));
      }
      throw err;
    }
    return res.redirect(withToast(back, 'Submitted for review. A second person issues it from the review queue'));
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/:rid/issue`, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    const { recommendation, alreadyIssued } = await recommendations.issue(db, actor, thirdParty.id, req.params.aid, req.params.rid, req.body);
    if (!alreadyIssued) await require('../lib/tprm/messages').recommendationIssued(db, { workspaceId: actor.ws.id, assessmentId: Number(req.params.aid), recommendationId: recommendation.id });
    return res.redirect(withToast(back, alreadyIssued
      ? `Recommendation version ${recommendation.version} was already issued`
      : `Recommendation version ${recommendation.version} issued`));
  }, { permission: 'tp.review' }));

  app.post(`${BASE}/:rid/request-changes`, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    await recommendations.requestChanges(db, actor, thirdParty.id, req.params.aid, req.params.rid, req.body);
    return res.redirect(withToast(back, 'Changes requested from the author'));
  }, { permission: 'tp.review' }));

  app.post(`${BASE}/:rid/withdraw`, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    await recommendations.withdraw(db, actor, thirdParty.id, req.params.aid, req.params.rid, req.body);
    return res.redirect(withToast(back, 'Recommendation withdrawn'));
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/:rid/auto-conditions/:cid/remove`, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    try {
      await require('../lib/tprm/exit-plans').removeAutoCondition(db, actor, thirdParty.id, req.params.aid, req.params.rid, req.params.cid, req.body);
    } catch (err) {
      if (err instanceof TprmError && err.status === 409) return res.redirect(withToast(back, err.message, 'error'));
      throw err;
    }
    return res.redirect(withToast(back, 'Automatic condition removed. The override and its reason are recorded'));
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/:rid/override-outcome`, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    try {
      await require('../lib/tprm/exit-plans').changeOutcomeAfterOverride(db, actor, thirdParty.id, req.params.aid, req.params.rid, req.body);
    } catch (err) {
      if (err instanceof TprmError && err.status === 409) return res.redirect(withToast(back, err.message, 'error'));
      throw err;
    }
    return res.redirect(withToast(back, 'Outcome changed. The manager\'s reason is recorded'));
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/:rid/recall`, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    const recalled = await recommendations.recall(db, actor, thirdParty.id, req.params.aid, req.params.rid, req.body);
    return res.redirect(withToast(back, `Version ${recalled.version} recalled to draft: it is no longer in the review queue`));
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/:rid/reassign`, requireAuth, handler(async (req, res, actor, thirdParty, back) => {
    const moved = await recommendations.reassign(db, actor, thirdParty.id, req.params.aid, req.params.rid, req.body, { lookup });
    return res.redirect(withToast(back, `Recommendation handed to ${moved.author_name || 'the new author'}`));
  }, { permission: 'tp.manage' }));
}

module.exports = { register: registerRoutes };
