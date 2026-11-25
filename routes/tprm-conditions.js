'use strict';

const fs = require('fs');
const path = require('path');
const { withToast, auditCtx } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const conditions = require('../lib/tprm/conditions');
const conditionLinks = require('../lib/tprm/condition-links');
const { TprmError } = require('../lib/tprm/errors');

const PROOF_INLINE = Object.freeze({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' });

const NOT_FOUND = 'This third-party risk client does not exist, or it is not available to your account.';
const BASE = '/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid/conditions/:cid';
const PORTAL = '/workspaces/:wsId/client-portal/third-party-risk';
const FORBIDDEN = 'Your role does not allow changes to this assessment\'s conditions.';

function removeFiles(files) {
  for (const file of files || []) {
    try {
      if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (_) {}
  }
}

function registerRoutes(app, deps) {
  const { db, requireAuth, requireWorkspace, getWorkspace, permissionsFor, listWorkspaces, upload, resolveUploadPath, logAction } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };
  const aUrl = req => `/tprm/clients/${Number(req.params.wsId)}/third-parties/${Number(req.params.tpId)}/assessments/${Number(req.params.aid)}`;
  const recUrl = (wsId, rid) => `/workspaces/${Number(wsId)}/client-portal/third-party-risk/recommendations/${Number(rid)}`;
  const target = req => ({ via: 'firm', thirdPartyId: req.params.tpId, assessmentId: req.params.aid, conditionId: req.params.cid });

  function sendError(req, res, err, next) {
    if (err instanceof TprmError) {
      return res.status(err.status >= 400 && err.status < 600 ? err.status : 500)
        .render('error', { user: req.user, ws: req.workspace || null, message: err.message });
    }
    return next(err);
  }

  async function loadActor(req, res, permission) {
    const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
    if (!loaded) { res.status(404).render('error', { user: req.user, message: NOT_FOUND }); return null; }
    const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
    if (permission !== 'tp.view' && !access.can(req.user, actor.perms, permission)) {
      res.status(403).render('error', { user: req.user, message: FORBIDDEN });
      return null;
    }
    return actor;
  }

  function handler(fn, { permission = 'tp.view' } = {}) {
    return async (req, res, next) => {
      try {
        const actor = req.tprmActor || await loadActor(req, res, permission);
        if (!actor) return undefined;
        return await fn(req, res, actor);
      } catch (err) {
        return sendError(req, res, err, next);
      }
    };
  }

  const files = upload.array('files', conditions.LIMITS.filesPerProof);
  function acceptFiles(req, res, next) {
    files(req, res, err => {
      if (!err) return next();
      if (err && typeof err.code === 'string' && err.code.startsWith('LIMIT_')) {
        removeFiles(Array.isArray(req.files) ? req.files : []);
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? 'A file is larger than the 50 MB limit. Nothing was submitted.'
          : err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT'
            ? `Attach at most ${conditions.LIMITS.filesPerProof} files at a time. Nothing was submitted.`
            : 'The upload could not be read. Nothing was submitted.';
        return res.status(400).render('error', { user: req.user, ws: req.workspace || null, message });
      }
      return next(err);
    });
  }

  async function beforeFirmUpload(req, res, next) {
    try {
      const actor = await loadActor(req, res, 'tp.manage');
      if (!actor) return undefined;
      await conditions.assertCanSubmit(db, actor, target(req));
      req.tprmActor = actor;
      return next();
    } catch (err) {
      return sendError(req, res, err, next);
    }
  }

  app.post(`${BASE}/proofs`, requireAuth, beforeFirmUpload, acceptFiles, handler(async (req, res, actor) => {
    const staged = Array.isArray(req.files) ? req.files : [];
    try {
      await conditions.submitProof(db, actor, target(req), staged, req.body);
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return res.redirect(withToast(`${aUrl(req)}?step=decision#conditions`, err.message, 'error'));
      }
      throw err;
    }
    return res.redirect(withToast(`${aUrl(req)}?step=decision#conditions`, 'Proof uploaded. Someone else verifies it'));
  }, { permission: 'tp.manage' }));

  function reviewRoute(path, fn, message) {
    app.post(`${BASE}/${path}`, requireAuth, handler(async (req, res, actor) => {
      try {
        await fn(db, actor, req.params.tpId, req.params.aid, req.params.cid, req.body);
      } catch (err) {
        if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
          return res.redirect(withToast(`${aUrl(req)}?step=decision#conditions`, err.message, 'error'));
        }
        throw err;
      }
      return res.redirect(withToast(`${aUrl(req)}?step=decision#conditions`, message));
    }, { permission: 'tp.manage' }));
  }
  reviewRoute('verify', conditions.verify, 'Condition verified');
  reviewRoute('request-changes', conditions.requestChanges, 'Changes requested');
  reviewRoute('waive', conditions.waive, 'Condition waived');

  const LINK = '/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid/conditions-link';
  app.post(LINK, requireAuth, handler(async (req, res, actor) => {
    let created;
    try {
      created = await conditionLinks.create(db, actor, req.params.tpId, req.params.aid, req.body);
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return res.redirect(withToast(`${aUrl(req)}?step=decision#conditions`, err.message, 'error'));
      }
      throw err;
    }
    const emailed = req.body.send_email === '1'
      ? await require('../lib/tprm/messages').conditionsLinkEmail(db, { workspaceId: actor.ws.id, assessmentId: created.head.assessment_id,
        link: { ...created.link, recommendation_id: created.head.recommendation_id, created_by: actor.user.id }, url: created.url })
      : null;
    res.set('Cache-Control', 'no-store');
    return res.render('tprm_condition_link_created', {
      user: req.user,
      active: 'tprm-portfolio',
      back: `${aUrl(req)}?step=decision#conditions`,
      newLink: {
        url: created.url,
        recipientName: created.link.recipient_name,
        recipientEmail: created.link.recipient_email,
        expiresAt: created.link.expires_at,
        replaced: created.replaced.length > 0,
        conditions: created.conditionIds.length,
        emailed,
      },
    });
  }, { permission: 'tp.manage' }));

  app.post(`${LINK}/:lid/revoke`, requireAuth, handler(async (req, res, actor) => {
    try {
      await conditionLinks.revoke(db, actor, req.params.tpId, req.params.aid, req.params.lid, req.body);
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return res.redirect(withToast(`${aUrl(req)}?step=decision#conditions`, err.message, 'error'));
      }
      throw err;
    }
    return res.redirect(withToast(`${aUrl(req)}?step=decision#conditions`, 'Conditions link revoked: it no longer opens'));
  }, { permission: 'tp.manage' }));

  app.get(`${BASE}/files/:fid/download`, requireAuth, handler(async (req, res, actor) => {
    const file = await conditions.firmProofFile(db, actor, req.params.tpId, req.params.aid, req.params.cid, req.params.fid);
    const stored = await resolveUploadPath(file.stored_path, actor.ws.firm_id);
    if (!stored || !fs.existsSync(stored)) {
      if (req.query.inline === '1') {
        res.set('X-Content-Type-Options', 'nosniff');
        return res.status(404).type('text/plain; charset=utf-8').end(Buffer.from('This file is missing from storage, so it cannot be shown. Contact your administrator.', 'utf8'));
      }
      return res.status(404).render('error', { user: req.user, message: 'This file is missing from storage. Contact your administrator.' });
    }
    res.set('X-Content-Type-Options', 'nosniff');
    const inlineType = req.query.inline === '1' ? PROOF_INLINE[path.extname(String(file.original_name || '')).toLowerCase()] : null;
    if (inlineType) {
      res.type(inlineType);
      res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
      return res.sendFile(path.basename(stored), { root: path.dirname(stored) });
    }
    return res.download(stored, file.original_name);
  }));

  app.get('/tprm/conditions', requireAuth, async (req, res, next) => {
    try {
      if (!access.isFirmUser(req.user) || !access.firmCan(req.user, 'tp.view')) {
        return res.status(403).render('error', { user: req.user, message: 'Third-party risk is available to consulting-team accounts.' });
      }
      return res.render('tprm_conditions_due', {
        user: req.user,
        active: 'tprm-portfolio',
        due: await conditions.conditionsDue(lookup, req.user),
        C: conditions,
      });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/tprm/review', requireAuth, async (req, res, next) => {
    try {
      if (access.isFirmUser(req.user) && access.firmCan(req.user, 'tp.manage')) {
        res.locals.conditionProofQueue = await conditions.proofQueue(lookup, req.user);
        res.locals.conditionLabels = conditions;
      }
    } catch (err) {
      return next(err);
    }
    return next();
  });

  const portalReady = (req, res) => access.isClientUser(req.user) && res.locals.tpPortalEnabled === true;
  const portalNotFound = (req, res) => res.status(404).render('error', {
    user: req.user, ws: req.workspace, message: 'This page does not exist, or it is not available to your account.',
  });
  const portalActor = (req, res) => ({ user: req.user, perms: res.locals.userPerms, ws: req.workspace });

  async function beforePortalUpload(req, res, next) {
    try {
      if (!portalReady(req, res)) return portalNotFound(req, res);
      req.tprmCondition = await conditions.assertCanSubmit(db, portalActor(req, res), { via: 'portal', conditionId: req.params.cid });
      return next();
    } catch (err) {
      return sendError(req, res, err, next);
    }
  }

  app.post(`${PORTAL}/conditions/:cid/proofs`, requireAuth, requireWorkspace, beforePortalUpload, acceptFiles, async (req, res, next) => {
    const staged = Array.isArray(req.files) ? req.files : [];
    const back = `${recUrl(req.workspace.id, req.tprmCondition.recommendation_id)}#conditions`;
    try {
      const result = await conditions.submitProof(db, portalActor(req, res), { via: 'portal', conditionId: req.params.cid }, staged, req.body);
      await logAction(req.user.id, req.workspace.id, 'tprm_condition_proof_submitted', 'tp_condition', Number(req.params.cid),
        { proof_id: result.proof.id, files: result.proof.files.length }, auditCtx(req));
      return res.redirect(withToast(back, 'Your proof has been sent to your consultants'));
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return res.redirect(withToast(back, err.message, 'error'));
      }
      return sendError(req, res, err, next);
    }
  });

  app.get(`${PORTAL}/conditions/files/:fid/download`, requireAuth, requireWorkspace, async (req, res) => {
    if (!portalReady(req, res)) return portalNotFound(req, res);
    const file = await conditions.portalProofFile(db, req.workspace, req.params.fid);
    if (!file) return portalNotFound(req, res);
    const stored = await resolveUploadPath(file.stored_path, req.workspace.firm_id);
    if (!stored || !fs.existsSync(stored)) return portalNotFound(req, res);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.download(stored, file.original_name);
  });
}

module.exports = { register: registerRoutes };
