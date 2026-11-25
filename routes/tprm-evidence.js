'use strict';

const fs = require('fs');
const path = require('path');
const fileStore = require('../lib/file-store');
const { withToast } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const register = require('../lib/tprm/register');
const assessments = require('../lib/tprm/assessments');
const evidence = require('../lib/tprm/evidence');
const findings = require('../lib/tprm/findings');
const aiReview = require('../lib/tprm/ai-review');
const { TprmError } = require('../lib/tprm/errors');

const NOT_FOUND = 'This third-party risk client does not exist, or it is not available to your account.';
const BASE = '/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid';
const FORBIDDEN = 'Your role does not allow changes to this assessment\'s evidence and findings.';

const INLINE_TYPES = Object.freeze({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' });
const TEXT_TYPES = Object.freeze(['.docx', '.xlsx', '.txt', '.csv', '.md']);
const TEXT_MAX = 200000;
const FILTER_NAMES = Object.freeze(['unexpected', 'all', 'not_reviewed']);

function clientView(ws) {
  return { id: ws.id, name: ws.brand_display_name || ws.client_name, sector: ws.sector || null };
}

async function removeFiles(files, resolve) {
  for (const file of files || []) {
    try {
      const target = file && file.path ? file.path : await resolve(file);
      if (target) await fileStore.remove(target);
    } catch (_) {}
  }
}

function registerRoutes(app, deps) {
  const { db, requireAuth, getWorkspace, permissionsFor, listWorkspaces, upload, resolveUploadPath } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };
  const aUrl = (actor, tpId, aid) => `/tprm/clients/${actor.ws.id}/third-parties/${Number(tpId)}/assessments/${Number(aid)}`;

  function sendError(req, res, err, next) {
    if (err instanceof TprmError) {
      return res.status(err.status >= 400 && err.status < 600 ? err.status : 500).render('error', { user: req.user, message: err.message });
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

  async function beforeUpload(req, res, next) {
    try {
      const actor = await loadActor(req, res, 'tp.manage');
      if (!actor) return undefined;
      const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
      await evidence.assertCanUpload(db, actor, thirdParty.id, req.params.aid);
      req.tprmActor = actor;
      return next();
    } catch (err) {
      return sendError(req, res, err, next);
    }
  }

  const files = upload.array('files', evidence.LIMITS.filesPerUpload);
  function acceptFiles(req, res, next) {
    files(req, res, err => {
      if (!err) return next();
      if (err && typeof err.code === 'string' && err.code.startsWith('LIMIT_')) {
        removeFiles(Array.isArray(req.files) ? req.files : []);
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? 'A file is larger than the 50 MB limit. Nothing was uploaded.'
          : err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT'
            ? `Upload at most ${evidence.LIMITS.filesPerUpload} files at a time. Nothing was uploaded.`
            : 'The upload could not be read. Nothing was uploaded.';
        return res.status(400).render('error', { user: req.user, message });
      }
      return next(err);
    });
  }

  app.post(`${BASE}/evidence`, requireAuth, beforeUpload, acceptFiles, handler(async (req, res, actor) => {
    const staged = Array.isArray(req.files) ? req.files : [];
    let result;
    try {
      result = await evidence.addEvidence(db, actor, req.params.tpId, req.params.aid, staged, req.body);
    } catch (err) {
      removeFiles(staged);
      throw err;
    }
    removeFiles(result.skipped.map(s => s.file));
    const created = result.created.length;
    const skipped = result.skipped.length;
    const message = (created ? `${created} file${created === 1 ? '' : 's'} uploaded` : 'Nothing new was uploaded')
      + (skipped ? `. ${skipped} ${skipped === 1 ? 'file was' : 'files were'} already on this assessment and ${skipped === 1 ? 'was' : 'were'} not stored again` : '');
    return res.redirect(withToast(`${aUrl(actor, req.params.tpId, req.params.aid)}?step=evidence#evidence`, message, created ? undefined : 'error'));
  }, { permission: 'tp.manage' }));

  app.get(`${BASE}/evidence/:eid/download`, requireAuth, handler(async (req, res, actor) => {
    const file = await evidence.evidenceFile(db, actor, req.params.tpId, req.params.aid, req.params.eid);
    const target = await resolveUploadPath(file.stored_path, actor.ws.firm_id, actor.ws.id);
    if (!target || !fs.existsSync(target)) {
      if (req.query.inline === '1') {
        res.set('X-Content-Type-Options', 'nosniff');
        return res.status(404).type('text/plain; charset=utf-8').end(Buffer.from('This file is missing from storage, so it cannot be shown. Contact your administrator.', 'utf8'));
      }
      return res.status(404).render('error', { user: req.user, message: 'This file is missing from storage. Contact your administrator.' });
    }
    res.set('X-Content-Type-Options', 'nosniff');
    const inlineType = req.query.inline === '1' ? INLINE_TYPES[path.extname(String(file.original_name || '')).toLowerCase()] : null;
    if (inlineType) {
      res.type(inlineType);
      res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
      return res.sendFile(path.basename(target), { root: path.dirname(target) });
    }
    return res.download(target, file.original_name);
  }));

  app.get(`${BASE}/evidence/:eid/text`, requireAuth, handler(async (req, res, actor) => {
    const file = await evidence.evidenceFile(db, actor, req.params.tpId, req.params.aid, req.params.eid);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.set('Cache-Control', 'no-store');
    res.type('text/plain; charset=utf-8');
    if (!TEXT_TYPES.includes(path.extname(String(file.original_name || '')).toLowerCase())) {
      return res.status(415).send('This file is not shown as text here. Download it to read it.');
    }
    const read = await require('../lib/tprm/ai-review').extractFileText({ ...file, firm_id: actor.ws.firm_id, workspace_id: actor.ws.id });
    if (!read.text) {
      return res.status(read.listed === 'missing' ? 404 : 422).send(read.listed === 'missing'
        ? 'This file is missing from storage. Contact your administrator.'
        : 'The text of this file could not be read. Download it to read it.');
    }
    return res.end(Buffer.from(read.text.length > TEXT_MAX ? `${read.text.slice(0, TEXT_MAX)}\n\n[Shortened: download the file for the rest.]` : read.text, 'utf8'));
  }));

  app.post(`${BASE}/evidence/:eid/release`, requireAuth, handler(async (req, res, actor) => {
    const result = await evidence.releaseEvidence(db, actor, req.params.tpId, req.params.aid, req.params.eid, req.body);
    return res.redirect(withToast(`${aUrl(actor, req.params.tpId, req.params.aid)}?step=evidence#evidence`,
      result.unchanged ? 'This file was already released to the client' : `"${result.evidence.original_name}" released to the client`));
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/evidence/:eid/delete`, requireAuth, handler(async (req, res, actor) => {
    const result = await evidence.deleteEvidence(db, actor, req.params.tpId, req.params.aid, req.params.eid, req.body);
    try { await fileStore.removeStored(result.storedPath, actor.ws.firm_id, actor.ws.id); } catch (_) {}
    return res.redirect(withToast(`${aUrl(actor, req.params.tpId, req.params.aid)}?step=evidence#evidence`, `"${result.evidence.original_name}" deleted`));
  }, { permission: 'tp.manage' }));

  async function renderFindingForm(req, res, actor, { finding = null, values = null, errors = [], status = 200, fromAnswer = null, fromSuggestion = null } = {}) {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
    if (!assessments.evidenceChangeable(assessment)) throw new TprmError(409, assessments.evidenceFrozenMessage(assessment));
    const v = values || (finding
      ? { control_ref: finding.control_ref || '', severity: finding.severity, title: finding.title, description: finding.description || '',
        impact: finding.impact || '', status: finding.status, evidence: finding.evidence_ids.map(String), row_version: finding.row_version }
      : { control_ref: '', severity: '', title: '', description: '', impact: '', status: 'open', evidence: [] });
    return res.status(status).render('tprm_finding_form', {
      user: req.user,
      active: 'tprm-portfolio',
      tpClient: clientView(actor.ws),
      canManage: true,
      canSettings: access.can(req.user, actor.perms, 'tp.settings'),
      at: assessments,
      fd: findings,
      thirdParty, assessment, finding, errors, fromAnswer, fromSuggestion,
      values: { ...v, evidence: [].concat(v.evidence || []).map(String) },
      evidenceList: await evidence.listEvidence(db, actor, assessment),
    });
  }

  app.get(`${BASE}/findings/new`, requireAuth, handler(async (req, res, actor) => {
    if (req.query.suggestion) {
      const draft = await aiReview.findingDraft(db, actor, req.params.tpId, req.params.aid, req.query.suggestion);
      return renderFindingForm(req, res, actor, { values: draft, fromSuggestion: draft.fromSuggestion });
    }
    if (!req.query.answer) return renderFindingForm(req, res, actor);
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
    const draft = await require('../lib/tprm/questionnaire-review').findingDraft(db, actor, assessment, req.query.answer);
    return renderFindingForm(req, res, actor, { values: draft, fromAnswer: draft.fromAnswer });
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/findings`, requireAuth, handler(async (req, res, actor) => {
    try {
      const finding = await findings.addFinding(db, actor, req.params.tpId, req.params.aid, req.body);
      const answerId = Number(req.body.return_answer);
      const back = req.body.return_to === 'review' && Number.isSafeInteger(answerId) && answerId > 0
        ? `${aUrl(actor, req.params.tpId, req.params.aid)}?step=review${FILTER_NAMES.includes(String(req.body.answers_filter)) ? `&answers=${req.body.answers_filter}` : ''}#answer-${answerId}`
        : `${aUrl(actor, req.params.tpId, req.params.aid)}?step=evidence#findings`;
      return res.redirect(withToast(back, `Finding added: ${finding.title}`));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderFindingForm(req, res, actor, { values: req.body, errors: err.errors || [err.message], status: 400 });
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/ai-suggestions/:sid/accept-edited`, requireAuth, handler(async (req, res, actor) => {
    try {
      const { finding } = await aiReview.acceptEdited(db, actor, req.params.tpId, req.params.aid, req.params.sid, req.body);
      return res.redirect(withToast(`${aUrl(actor, req.params.tpId, req.params.aid)}?step=evidence#findings`, `Finding added from Brevis's suggestion: ${finding.title}`));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderFindingForm(req, res, actor, { values: req.body, errors: err.errors || [err.message], status: 400,
          fromSuggestion: { id: Number(req.params.sid) } });
      }
      if (err instanceof TprmError && err.status === 409) {
        return res.redirect(withToast(`${aUrl(actor, req.params.tpId, req.params.aid)}?step=review#ai-review`, err.message, 'error'));
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.get(`${BASE}/findings/:fid/edit`, requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
    const finding = await findings.getFinding(db, actor, assessment, req.params.fid);
    return renderFindingForm(req, res, actor, { finding });
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/findings/:fid`, requireAuth, handler(async (req, res, actor) => {
    try {
      const result = await findings.updateFinding(db, actor, req.params.tpId, req.params.aid, req.params.fid, req.body);
      return res.redirect(withToast(`${aUrl(actor, req.params.tpId, req.params.aid)}?step=evidence#findings`, result.unchanged ? 'No changes to save' : 'Finding saved'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
        const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
        const finding = await findings.getFinding(db, actor, assessment, req.params.fid);
        return renderFindingForm(req, res, actor, { finding, values: req.body, errors: err.errors || [err.message], status: 400 });
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  const issues = require('../lib/tprm/issues');
  const issueMessages = () => require('../lib/tprm/messages');
  async function renderShare(req, res, actor, { values = null, errors = [], status = 200 } = {}) {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const assessment = await assessments.getAssessment(db, actor, thirdParty.id, req.params.aid);
    const finding = await findings.getFinding(db, actor, assessment, req.params.fid);
    return res.status(status).render('tprm_issue_share', {
      user: req.user, active: 'tprm-portfolio', tpClient: clientView(actor.ws),
      canSettings: access.can(req.user, actor.perms, 'tp.settings'), at: assessments,
      thirdParty, assessment, finding, errors,
      values: values || { title: finding.title, body: finding.description || '' },
    });
  }
  const issuesBack = (actor, req, id) => `${aUrl(actor, req.params.tpId, req.params.aid)}?step=evidence${id ? `#issue-${id}` : '#issues'}`;

  app.get(`${BASE}/findings/:fid/share`, requireAuth, handler(async (req, res, actor) => {
    const live = await issues.liveIssueFor(db, actor.ws.id, req.params.fid);
    if (live) return res.redirect(withToast(issuesBack(actor, req, live), 'This finding is already shared with the third party.', 'error'));
    return renderShare(req, res, actor);
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/findings/:fid/share`, requireAuth, handler(async (req, res, actor) => {
    try {
      const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
      const result = await issues.share(db, actor, thirdParty.id, req.params.aid, req.params.fid, req.body);
      const sent = await issueMessages().issueShared(db, { workspaceId: actor.ws.id, assessmentId: Number(req.params.aid), issueId: result.issueId });
      if (sent && sent.reason === 'no_recipient') {
        return res.redirect(withToast(issuesBack(actor, req, result.issueId), 'Shared, but the third party has no main contact and no working link, so no one was emailed. Add a main contact on its People tab.', 'error'));
      }
      return res.redirect(withToast(issuesBack(actor, req, result.issueId), 'Shared with the third party'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) return renderShare(req, res, actor, { values: req.body, errors: err.errors || [err.message], status: 400 });
      if (err instanceof TprmError && err.status === 409) return res.redirect(withToast(issuesBack(actor, req), err.message, 'error'));
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.post(`${BASE}/findings/:fid/client-reply`, requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const back = `/tprm/clients/${actor.ws.id}/third-parties/${thirdParty.id}/assessments/${Number(req.params.aid)}?step=evidence#finding-${Number(req.params.fid) || 0}`;
    try {
      const r = await require('../lib/tprm/finding-comments').firmAdd(db, actor, req.params.aid, req.params.fid, req.body);
      if (deps.logAction) await deps.logAction(req.user.id, actor.ws.id, 'tprm_finding_firm_reply', 'tp_finding', r.findingId, {}, require('../lib/http-helpers').auditCtx(req));
      return res.redirect(withToast(back, 'Reply sent to the client'));
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return res.redirect(withToast(back, err.message, 'error'));
      throw err;
    }
  }, { permission: 'tp.manage' }));

  for (const [verb, fn, done] of [['reply', 'firmReply', 'Reply sent'], ['agree', 'agree', 'Fix agreed'], ['withdraw', 'withdraw', 'Issue withdrawn']]) {
    app.post(`${BASE}/issues/:iid/${verb}`, requireAuth, handler(async (req, res, actor) => {
      try {
        const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
        const result = await issues[fn](db, actor, thirdParty.id, req.params.aid, req.params.iid, req.body);
        if (verb !== 'withdraw' && !result.internal) await issueMessages().issueFirmUpdate(db, { workspaceId: actor.ws.id, assessmentId: Number(req.params.aid), issueId: result.issueId, agreed: verb === 'agree' });
        const message = verb === 'agree' && result.conditionAdded ? 'Fix agreed and added as a condition of the draft recommendation' : result.internal ? 'Internal note added' : done;
        return res.redirect(withToast(issuesBack(actor, req, result.issueId), message));
      } catch (err) {
        if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return res.redirect(withToast(issuesBack(actor, req, req.params.iid), err.message, 'error'));
        throw err;
      }
    }, { permission: 'tp.manage' }));
  }

  app.post(`${BASE}/findings/:fid/remove`, requireAuth, handler(async (req, res, actor) => {
    const result = await findings.removeFinding(db, actor, req.params.tpId, req.params.aid, req.params.fid, req.body);
    return res.redirect(withToast(`${aUrl(actor, req.params.tpId, req.params.aid)}?step=evidence#findings`, `Finding removed: ${result.finding.title}`));
  }, { permission: 'tp.manage' }));
}

module.exports = { register: registerRoutes };
