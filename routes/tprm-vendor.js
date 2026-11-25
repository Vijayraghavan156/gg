'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const fileStore = require('../lib/file-store');
const questionnaires = require('../lib/tprm/questionnaires');
const vendorAnswers = require('../lib/tprm/vendor-answers');
const conditionLinks = require('../lib/tprm/condition-links');
const messages = require('../lib/tprm/messages');
const issues = require('../lib/tprm/issues');
const contractChecklist = require('../lib/tprm/contract-review');
const vendorSheet = require('../lib/tprm/vendor-sheet');
const vendorSession = require('../lib/tprm/vendor-session');
const vendorPortal = require('../lib/tprm/vendor-portal');
const vendorPeople = require('../lib/tprm/vendor-people');
const SHEET_STALE = 'A colleague changed this answer on the page after your spreadsheet was downloaded. Nothing was saved: download a fresh spreadsheet, copy your changes into it and upload that.';
const PORTAL_NOTICES = Object.freeze({
  invited: 'Your colleague is added and has been emailed how to sign in.',
  removed: 'The person is removed. They can no longer sign in for your company.',
  handed_over: 'The main contact has changed. You are now a colleague.',
  details_saved: 'Your details are saved.',
});
const uploadSecurity = require('../lib/upload-security');
const { createFixedWindowLimiter } = require('../lib/rate-limit');
const { TprmError } = require('../lib/tprm/errors');
const format = require('../lib/tprm/format');
const { ymdInZone } = require('../lib/dates');

const RATE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 120 });
const POST_RATE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 60 });
const limiter = createFixedWindowLimiter(RATE_LIMIT);
const postLimiter = createFixedWindowLimiter(POST_RATE_LIMIT);
const signInLimiter = createFixedWindowLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const conditionsLimiter = createFixedWindowLimiter(RATE_LIMIT);
const conditionsPostLimiter = createFixedWindowLimiter(POST_RATE_LIMIT);
const CONDITIONS_PREFIX = conditionLinks.LINK_PATH;
const INVALID_STATUS = 404;
const PREFIX = questionnaires.LINK_PATH;
const PORTAL = vendorSession.PORTAL_PATH;
const BODY_LIMITS = Object.freeze({
  multipartBytes: vendorAnswers.LIMITS.filesPerRequest * vendorAnswers.LIMITS.fileBytes + 2 * 1024 * 1024,
  formBytes: 64 * 1024,
});
const NOTICES = Object.freeze({
  saved: 'Your answers are saved. You can come back to this link to continue.',
  ai_added: 'Your answers are saved. Because you answered Yes to AIS-01, an AI Services section has been added to the list of sections.',
  ai_removed: 'Your answers are saved. Because you answered No to AIS-01, the AI Services questions have been removed.',
  ai_kept: 'Your answers are saved. You changed AIS-01 to No after answering AI Services questions, so those questions stay and the firm will see the change.',
  answered: 'Thank you: your response has been sent.',
  report_added: 'Your report is saved. The questions it covers no longer need evidence from you.',
  report_updated: 'Your report is updated.',
  report_removed: 'Your report is removed. The questions it covered need evidence again.',
  documents_added: 'Your documents are added. Choose them on each question they support.',
  documents_same: 'You had already added these files, so nothing new was added.',
  document_saved: 'The description is saved.',
  document_deleted: 'The document is deleted.',
  sheet_saved: 'Your spreadsheet is uploaded and the answers in it are saved. Check any sections marked for attention, and add evidence files here.',
  sheet_same: 'Your spreadsheet matches what is already saved, so nothing changed.',
  assigned: 'Saved. Colleagues given new sections have been emailed.',
});

function publicHeaders(res) {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
}

const isPost = req => req.method === 'POST' && typeof req.path === 'string' && (req.path.startsWith(PREFIX) || req.path.startsWith(conditionLinks.LINK_PATH) || req.path.startsWith(PORTAL));
const isMultipart = req => /^multipart\/form-data(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''));
const isForm = req => /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''));

function renderView(res, status, view, data) {
  return new Promise((resolve, reject) => {
    res.render(view, data, (err, html) => {
      if (err) return reject(err);
      res.status(status).send(html);
      return resolve();
    });
  });
}

function plainError(res) {
  if (!res.headersSent) res.status(500).type('text/plain').send('Something went wrong. Please try the link again in a few minutes.');
}

function renderState(res, status, state, extra = {}) {
  return renderView(res, status, 'tprm_vendor_link', { state, clientName: null, submittedAt: null, ...extra });
}

const invalidPage = res => renderState(res, INVALID_STATUS, 'invalid');

function logError(req, err) {
  const prefix = String(req.path || '').startsWith(CONDITIONS_PREFIX) ? CONDITIONS_PREFIX : PREFIX;
  console.error('[request_error]', { method: req.method, path: `${prefix}[token]`, error: err && err.stack ? err.stack : String(err) });
}

function uploadedFiles(ctx, stored) {
  return fileStore.candidates(path.basename(String(stored || '')), ctx.firmId, ctx.workspaceId).map(p => ({ path: p }));
}

function removeFiles(files) {
  for (const file of files || []) {
    try { if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) {}
    if (file && file.path) fileStore.removeLater(file.path);
  }
}

const smallForm = express.urlencoded({ extended: true, limit: BODY_LIMITS.formBytes, parameterLimit: 400 });

function bodyGuard(req, res, next) {
  if (!isPost(req)) return next();
  const refuse = (status, state) => renderState(res, status, state).catch(err => { logError(req, err); plainError(res); });
  publicHeaders(res);
  if (isMultipart(req)) {
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length) || length < 0) return refuse(411, 'too_large');
    if (length > BODY_LIMITS.multipartBytes) return refuse(413, 'too_large');
    return next();
  }
  if (!isForm(req)) return refuse(415, 'forbidden');
  return smallForm(req, res, err => {
    if (err) return refuse(err.status === 413 ? 413 : 400, err.status === 413 ? 'too_large' : 'forbidden');
    return next();
  });
}

function sameOrigin(req) {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host !== req.get('host')) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = fileStore.dirFor(req.tprmVendor.firmId, req.tprmVendor.workspaceId);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    } catch (_) {}
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const safe = String(file.originalname || 'file').replace(/[^\w.\-]/g, '_').slice(-150);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${safe}`);
  },
});
const multipart = multer({
  storage,
  limits: { fileSize: vendorAnswers.LIMITS.fileBytes, files: 600, fields: 4000, parts: 4600, fieldSize: 20 * 1024, fieldNameSize: 64 },
}).any();

function readMultipart(req) {
  return new Promise(resolve => {
    if (!isMultipart(req)) return resolve({ files: [] });
    multipart(req, null, err => {
      const files = Array.isArray(req.files) ? req.files : [];
      if (err) {
        removeFiles(files);
        return resolve({ error: err, files: [] });
      }
      return resolve({ files });
    });
  });
}

function limitError(err) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return `A file is larger than ${vendorAnswers.LIMITS.fileBytes / (1024 * 1024)} MB. Nothing was saved: choose a smaller file.`;
  }
  return 'The form could not be read. Nothing was saved: reload the page and try again.';
}

const firmRoutes = [];
const FIRM_PATH = '/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid/answer-for-supplier';

function registerFirmRoutes(app, { db, requireAuth, getWorkspace, permissionsFor, listWorkspaces }) {
  const access = require('../lib/tprm/access');
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };
  const notFound = res => res.status(404).render('error', { user: res.req.user, message: 'This questionnaire does not exist, or it is not available to your account.' });
  const fromFirm = async (req, res, next) => {
    try {
      const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
      if (!loaded || !access.can(req.user, loaded.perms, 'tp.manage')) return notFound(res);
      const t = await questionnaires.firmEntryTarget(db, loaded.ws.id, req.params.tpId, req.params.aid);
      if (!t) return notFound(res);
      const back = `/tprm/clients/${loaded.ws.id}/third-parties/${Number(req.params.tpId)}/assessments/${t.assessmentId}`;
      if (['submitted', 'under_review', 'closed'].includes(t.questionnaireStatus)) {
        const message = 'The questionnaire is submitted: its answers are on the review step.';
        if (req.method === 'GET') return res.redirect(303, `${back}?step=review&toast=${encodeURIComponent(message)}#questionnaire-answers`);
        return res.status(409).render('error', { user: req.user, message });
      }
      if (!t.key) {
        const message = 'The third party has no working link, so answers cannot be entered for them. Make a link first: it need not be emailed.';
        if (req.method === 'GET') return res.redirect(303, `${back}?step=questionnaire&toast=${encodeURIComponent(message)}&toastKind=error#questionnaire`);
        return res.status(409).render('error', { user: req.user, message });
      }
      req.vkey = t.key;
      req.vtoken = null;
      req.vbase = `${back}/answer-for-supplier`;
      req.vsession = null;
      req.vsessionLoaded = true;
      req.vperson = null;
      req.vfirm = req.user;
      req.vfirmBack = back;
      return next();
    } catch (err) { return next(err); }
  };
  const firmAllowed = new Set(['get:', 'post:/save', 'post:/submit', 'get:/spreadsheet']);
  for (const r of firmRoutes) if (firmAllowed.has(`${r.method}:${r.suffix}`)) app[r.method](`${FIRM_PATH}${r.suffix}`, requireAuth, fromFirm, r.handler);
}

function registerRoutes(app, { db }) {
  const page = (res, status, data) => renderView(res, status, 'tprm_vendor_questionnaire', data);

  async function datesFor(workspaceId) {
    const row = Number(workspaceId) ? await db.prepare(`SELECT w.timezone, f.timezone AS firm_timezone FROM workspaces w
      LEFT JOIN firms f ON f.id = w.firm_id WHERE w.id = ?`).get(Number(workspaceId)) : null;
    return format.forZone(format.zoneOf({ timezone: row && row.timezone }, { timezone: row && row.firm_timezone }), { ymdInZone });
  }
  async function issuesHrefFor(req) {
    const vctx = await issues.vendorContext(db, req.vkey);
    if (!vctx) return null;
    return (await issues.vendorCount(db, vctx.workspaceId, vctx.assessmentId)).total ? `${req.vbase}/issues` : null;
  }
  async function datesForToken(token) {
    return datesFor(await questionnaires.linkWorkspaceId(db, token));
  }

  async function renderQuestionnaire(req, res, ctx, { status = 200, values = null, errors = [], notice = null, view = null, section = null,
    reportValues = null, postedVersions = null, postedComments = null } = {}) {
    const data = await vendorAnswers.pageData(db, ctx, { values });
    let shown = view || (ctx.mode === 'clarifying' ? 'clarify' : 'start');
    let index = Number(section) || null;
    if (shown === 'section') {
      const first = (errors || []).find(e => e && typeof e === 'object' && e.id && data.sectionOf.get(e.id));
      if (first && (!index || !data.sections[index - 1] || !data.sections[index - 1].questions.some(q => q.id === first.id))) {
        index = data.sectionOf.get(first.id);
      }
      if (!index || !data.sections[index - 1]) index = 1;
      if (!data.sections.length) shown = 'start';
    }
    if (ctx.mode === 'clarifying') shown = 'clarify';
    data.sheetLimitBytes = vendorSheet.LIMITS.fileBytes;
    const aft = aftFor(req, ctx.tokenHash);
    const issueCount = await issues.vendorCount(db, ctx.workspaceId, ctx.assessmentId);
    const contractInfo = ctx.mode === 'answering' ? await contractChecklist.vendorPage(db, { workspaceId: ctx.workspaceId, assessmentId: ctx.assessmentId,
      thirdPartyId: ctx.thirdPartyId, assessmentClosed: false }) : null;
    const frame = await vendorPortal.frameFor(db, { firm: data.firm, session: req.vsession, person: req.vperson, workspaceId: ctx.workspaceId,
      thirdPartyId: ctx.thirdPartyId, reviewer: ctx.issuer, active: ctx.mode === 'answering' ? null : 'review',
      review: ctx.mode === 'answering' ? null : { base: req.vbase, issues: issueCount.total > 0, issuesWaiting: issueCount.waiting, group: `Questionnaire for ${ctx.clientName}` },
      linkHome: req.vsession || req.vfirm ? null : { action: `${req.vbase}/home`, aft } });
    return page(res, status, {
      frame,
      contractInfo: contractInfo && contractInfo.total ? contractInfo : null,
      p: data,
      token: req.vtoken,
      base: req.vbase,
      signedIn: req.vperson || null,
      aft: aftFor(req, ctx.tokenHash),
      notice,
      errors,
      view: shown,
      section: shown === 'section' ? data.sections[index - 1] : null,
      reportValues,
      postedVersions: postedVersions && typeof postedVersions === 'object' ? postedVersions : null,
      postedComments: postedComments && typeof postedComments === 'object' ? postedComments : null,
      issueCount,
      canSubmit: vendorPortal.canSubmit(req.vperson, ctx.recipientEmail),
      assigned: req.vperson ? await vendorPeople.assignments(db, ctx.workspaceId, ctx.assessmentId) : null,
      colleagues: req.vperson ? await vendorPeople.list(db, ctx.workspaceId, ctx.thirdPartyId) : null,
      mainContact: req.vperson && req.vperson.role !== 'main' ? (await vendorPeople.list(db, ctx.workspaceId, ctx.thirdPartyId)).find(x => x.role === 'main') || null : null,
      tpf: await datesFor(ctx.workspaceId),
      firmEntry: req.vfirm ? { name: req.vfirm.name || req.vfirm.email, back: req.vfirmBack } : null,
    });
  }

  const sectionParam = value => {
    const n = Number(String(value || ''));
    return Number.isSafeInteger(n) && n >= 1 && n <= 500 ? n : null;
  };

  const aftKey = (req, hash) => (req.vfirm ? `${hash}:firm:${req.vfirm.id}` : req.vsession ? `${hash}:${req.vsession.tokenHash}` : hash);
  const aftFor = (req, hash) => vendorAnswers.formToken(aftKey(req, hash));
  const aftOk = (req, hash) => vendorAnswers.verifyFormToken(aftKey(req, hash), req.body && req.body._aft);

  async function sessionOf(req) {
    if (req.vsessionLoaded) return req.vsession;
    req.vsessionLoaded = true;
    req.vsession = await vendorSession.loadSession(db, vendorSession.readCookie(req));
    return req.vsession;
  }

  const fromToken = family => (req, _res, next) => {
    req.vkey = req.params.token;
    req.vtoken = req.params.token;
    req.vbase = `${family === 'c' ? CONDITIONS_PREFIX : PREFIX}${req.params.token}`;
    req.vsession = null;
    req.vperson = null;
    next();
  };

  const fromSession = family => async (req, res, next) => {
    publicHeaders(res);
    try {
      const session = await sessionOf(req);
      if (!session) {
        if (req.method === 'GET') return res.redirect(303, `${PORTAL}sign-in`);
        return await renderState(res, 403, 'signed_out');
      }
      const a = await vendorPortal.assessmentFor(db, session, req.params.aid);
      if (!a) return await invalidPage(res);
      if (family === 'i') {
        req.vkey = null;
        req.vtoken = null;
        req.vbase = `${PORTAL}a/${a.assessmentId}`;
        req.vperson = a.person;
        req.vassessment = a;
        return next();
      }
      const key = family === 'c' ? await vendorPortal.conditionsKey(db, a) : await vendorPortal.questionnaireKey(db, a);
      if (!key) return req.method === 'GET' ? res.redirect(303, `${PORTAL}home?notice=closed`) : await invalidPage(res);
      req.vkey = key;
      req.vtoken = null;
      req.vbase = `${PORTAL}a/${a.assessmentId}${family === 'c' ? '/c' : ''}`;
      req.vperson = a.person;
      return next();
    } catch (err) {
      logError(req, err);
      if (!res.headersSent) return renderState(res, 500, 'error').catch(() => plainError(res));
      return undefined;
    }
  };

  function vroute(method, family, suffix, handler) {
    if (family === 'q') firmRoutes.push({ method, suffix, handler });
    app[method](`${family === 'c' ? CONDITIONS_PREFIX : PREFIX}:token${suffix}`, fromToken(family === 'c' ? 'c' : 'q'), handler);
    app[method](`${PORTAL}a/:aid${family === 'c' ? '/c' : ''}${suffix}`, fromSession(family), handler);
  }

  const guarded = (limit, fn) => async (req, res) => {
    publicHeaders(res);
    const verdict = limit.hit(req.ip);
    if (!verdict.allowed) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      return renderState(res, 429, 'limited');
    }
    const staged = [];
    try {
      return await fn(req, res, staged);
    } catch (err) {
      removeFiles(staged);
      logError(req, err);
      if (!res.headersSent) {
        try {
          await renderState(res, 500, 'error');
        } catch (_) {
          plainError(res);
        }
      }
      return undefined;
    }
  };

  async function postPreamble(req, res, staged, { modes = ['answering'], view = null } = {}) {
    if (!sameOrigin(req)) { await renderState(res, 403, 'forbidden'); return null; }
    const ctx = await vendorAnswers.linkContext(db, req.vkey);
    if (!ctx || !modes.includes(ctx.mode)) { await invalidPage(res); return null; }
    req.tprmVendor = ctx;
    const read = await readMultipart(req);
    staged.push(...read.files);
    fileStore.keepStaged(req, res, read.files);
    if (read.error) {
      if (ctx.mode === 'answering') {
        const section = view === 'section' ? sectionParam(req.body && req.body.section) : null;
        await renderQuestionnaire(req, res, ctx, { status: 400, errors: [limitError(read.error)], view: section ? 'section' : null, section });
      }
      else await renderState(res, 400, 'too_large');
      return null;
    }
    if (!aftOk(req, ctx.tokenHash)) {
      removeFiles(staged);
      await renderState(res, 403, 'forbidden');
      return null;
    }
    return { ctx, files: read.files };
  }

  async function checkFiles(files) {
    if (files.length > vendorAnswers.LIMITS.filesPerRequest) {
      return `Attach at most ${vendorAnswers.LIMITS.filesPerRequest} files each time you save. Nothing was saved: choose fewer files and save again.`;
    }
    for (const file of files) {
      const result = uploadSecurity.validateUpload(file, uploadSecurity.GENERAL_UPLOAD_EXTENSIONS);
      if (!result.ok) return `${String(file.originalname || 'A file').slice(0, 120)}: ${result.message || 'the file did not pass the upload checks.'} Nothing was saved.`;
    }
    try {
      await fileStore.putMany(files.filter(f => f && f.path).map(f => f.path));
    } catch (err) {
      console.error('[file_store] could not store an upload:', err && err.name ? err.name : 'error');
      return 'Your files could not be saved right now. Nothing was saved: try again in a minute.';
    }
    return null;
  }

  vroute('get', 'q', '', guarded(limiter, async (req, res) => {
    const ctx = await vendorAnswers.linkContext(db, req.vkey);
    if (!ctx) {
      const done = await vendorAnswers.submittedLink(db, req.vkey);
      if (done) return renderState(res, 200, 'submitted', { ...done, issuesHref: await issuesHrefFor(req), tpf: await datesForToken(req.vkey) });
      return invalidPage(res);
    }
    const key = String(req.query.notice || '');
    const notice = Object.prototype.hasOwnProperty.call(NOTICES, key) ? NOTICES[key] : null;
    const section = sectionParam(req.query.s);
    const view = ctx.mode === 'clarifying' ? 'clarify' : req.query.view === 'review' ? 'confirm'
      : req.query.view === 'documents' ? 'documents' : section ? 'section' : 'start';
    return renderQuestionnaire(req, res, ctx, { notice, view, section });
  }));

  vroute('post', 'q', '/save', guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged, { view: 'section' });
    if (!pre) return undefined;
    const { ctx, files } = pre;
    const posted = sectionParam(req.body.section);
    const fileProblem = await checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: [fileProblem], values: safeValues(req.body), view: 'section', section: posted });
    }
    let result;
    try {
      result = await vendorAnswers.saveAnswers(db, req.vkey, req.body, files, { person: req.vperson, firmUser: req.vfirm || null });
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        const errors = err.errors || [err.message];
        return renderQuestionnaire(req, res, ctx, { status: err.status, errors, values: err.values || null, view: 'section', section: posted, postedVersions: req.body.v, postedComments: req.body.c });
      }
      throw err;
    }
    if (!result) { removeFiles(staged); return invalidPage(res); }
    removeFiles(result.staged);
    for (const stored of result.removedPaths) {
      removeFiles(uploadedFiles(ctx, stored));
    }
    if (req.body.intent === 'review') {
      const fresh = await vendorAnswers.linkContext(db, req.vkey);
      if (!fresh) return invalidPage(res);
      return renderQuestionnaire(req, res, fresh, { view: 'confirm' });
    }
    const notice = result.ai ? `ai_${result.ai}` : 'saved';
    const go = goTarget(req.body.go === 'jump' ? req.body.jump : req.body.go);
    if (go) {
      const here = `${req.vbase}`;
      if (go === 'start') return res.redirect(303, `${here}?notice=${notice}`);
      if (go === 'review') return res.redirect(303, `${here}?view=review&notice=${notice}`);
      if (go === 'documents') return res.redirect(303, `${here}?view=documents&notice=${notice}`);
      if (go === 'issues') return res.redirect(303, `${here}/issues`);
      if (go === 'contract') return res.redirect(303, `${here}/contract`);
      const portalGo = { home: 'home', pissues: 'issues', people: 'people', files: 'files' }[go];
      if (portalGo) {
        if (req.vsession) return res.redirect(303, `${PORTAL}${portalGo}`);
        const vctx = await issues.vendorContext(db, req.vtoken);
        return vctx ? linkSession(res, vctx, portalGo) : res.redirect(303, `${here}?notice=${notice}`);
      }
      const sections = await vendorAnswers.sectionList(db, ctx);
      let index = sections.findIndex(s => (s.ids || []).includes(go)) + 1;
      if (!index) index = Math.min(Math.max(posted || 1, 1), sections.length);
      if (!index) return res.redirect(303, `${here}?view=review&notice=${notice}`);
      return res.redirect(303, `${here}?s=${index}&notice=${notice}`);
    }
    if (!posted) {
      const anchor = result.ai === 'added' ? '#ai-services' : '';
      return res.redirect(303, `${req.vbase}?notice=${notice}${anchor}`);
    }
    if (req.body.intent === 'next') {
      const count = await vendorAnswers.sectionCount(db, ctx);
      if (posted >= count) return res.redirect(303, `${req.vbase}?view=review&notice=${notice}`);
      return res.redirect(303, `${req.vbase}?s=${posted + 1}&notice=${notice}`);
    }
    return res.redirect(303, `${req.vbase}?s=${posted}&notice=${notice}`);
  }));

  vroute('post', 'q', '/reports', guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged);
    if (!pre) return undefined;
    const { ctx, files } = pre;
    const fileProblem = files.length > 3 ? 'Attach at most three files to a report.' : await checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: [fileProblem], view: 'start' });
    }
    let result;
    try {
      result = await vendorAnswers.saveReport(db, req.vkey, req.body, files);
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        const errors = err.errors || [err.message];
        return renderQuestionnaire(req, res, ctx, { status: err.status, errors, view: 'start',
          reportValues: err.reportKind ? { kind: err.reportKind, ...err.reportValues } : null });
      }
      throw err;
    }
    if (!result) { removeFiles(staged); return invalidPage(res); }
    removeFiles(result.staged);
    for (const stored of result.removedPaths) {
      removeFiles(uploadedFiles(ctx, stored));
    }
    const notice = result.outcome === 'added' ? 'report_added' : result.outcome === 'removed' ? 'report_removed' : 'report_updated';
    return res.redirect(303, `${req.vbase}?notice=${notice}#reports`);
  }));

  vroute('post', 'q', '/documents', guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged);
    if (!pre) return undefined;
    const { ctx, files } = pre;
    const fileProblem = await checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: [fileProblem], view: 'documents' });
    }
    let result;
    try {
      result = await vendorAnswers.addDocuments(db, req.vkey, req.body, files);
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return renderQuestionnaire(req, res, ctx, { status: err.status, errors: err.errors || [err.message], view: 'documents' });
      }
      throw err;
    }
    if (!result) { removeFiles(staged); return invalidPage(res); }
    removeFiles(result.staged);
    const addedNotice = result.added ? 'documents_added' : 'documents_same';
    if (req.vsession && req.body.back === 'files') return res.redirect(303, `${PORTAL}files?notice=${addedNotice}#review-${ctx.assessmentId}`);
    return res.redirect(303, `${req.vbase}?view=documents&notice=${addedNotice}`);
  }));

  vroute('post', 'q', '/documents/:eid', guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged);
    if (!pre) return undefined;
    removeFiles(staged);
    let result;
    try {
      result = await vendorAnswers.updateDocument(db, req.vkey, req.params.eid, req.body);
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return renderQuestionnaire(req, res, pre.ctx, { status: err.status, errors: err.errors || [err.message], view: 'documents' });
      }
      throw err;
    }
    if (!result) return invalidPage(res);
    if (result.path) removeFiles(uploadedFiles(pre.ctx, result.path));
    const docNotice = result.deleted ? 'document_deleted' : 'document_saved';
    if (req.vsession && req.body.back === 'files') return res.redirect(303, `${PORTAL}files?notice=${docNotice}#review-${pre.ctx.assessmentId}`);
    return res.redirect(303, `${req.vbase}?view=documents&notice=${docNotice}`);
  }));

  vroute('post', 'q', '/submit', guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged);
    if (!pre) return undefined;
    removeFiles(staged);
    let result;
    try {
      result = await vendorAnswers.submit(db, req.vkey, { person: req.vperson, firmUser: req.vfirm || null });
    } catch (err) {
      if (err instanceof TprmError && err.status === 403) return renderQuestionnaire(req, res, pre.ctx, { status: 403, errors: [err.message], view: 'confirm' });
      throw err;
    }
    if (!result) return invalidPage(res);
    if (result.problems) return renderQuestionnaire(req, res, pre.ctx, { status: 409, view: 'confirm' });
    if (req.vfirm) return res.redirect(303, `${req.vfirmBack}?step=review&toast=${encodeURIComponent('Submitted for the third party. The answers are ready to review')}`);
    await messages.vendorSubmitted(db, result);
    return renderState(res, 200, 'submitted', { clientName: result.clientName, submittedAt: result.submittedAt, issuesHref: await issuesHrefFor(req), tpf: await datesFor(pre.ctx.workspaceId) });
  }));

  vroute('post', 'q', '/clarifications/:cid', guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged, { modes: ['answering', 'clarifying'] });
    if (!pre) return undefined;
    const { ctx, files } = pre;
    if (files.length > 1 || files.some(f => f.fieldname !== 'file')) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: ['Attach at most one file to a response.'], view: 'clarify' });
    }
    const fileProblem = await checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: [fileProblem], view: 'clarify' });
    }
    let result;
    try {
      result = await vendorAnswers.answerClarification(db, req.vkey, req.params.cid, req.body, files[0] || null, { person: req.vperson });
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return renderQuestionnaire(req, res, ctx, { status: err.status, errors: [err.message], view: 'clarify' });
      }
      throw err;
    }
    if (!result) { removeFiles(staged); return invalidPage(res); }
    if (result.staged) removeFiles([result.staged]);
    await messages.clarificationAnswered(db, result);
    return res.redirect(303, `${req.vbase}?notice=answered`);
  }));

  vroute('get', 'q', '/spreadsheet', guarded(limiter, async (req, res) => {
    const ctx = await vendorAnswers.linkContext(db, req.vkey);
    if (!ctx || ctx.mode !== 'answering') return invalidPage(res);
    const buffer = await vendorSheet.buildWorkbook(await vendorSheet.pageFor(db, ctx));
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${vendorSheet.fileName(ctx.clientName)}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(buffer);
  }));

  vroute('post', 'q', '/spreadsheet', guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged, { view: 'start' });
    if (!pre) return undefined;
    const { ctx, files } = pre;
    const refuse = message => renderQuestionnaire(req, res, ctx, { status: 400, errors: [message], view: 'start' });
    let buffer = null;
    try {
      if (files.length !== 1 || files[0].fieldname !== 'sheet') return await refuse('Choose one filled-in spreadsheet to upload.');
      const file = files[0];
      if (!/\.xlsx$/i.test(String(file.originalname || ''))) return await refuse('Upload the spreadsheet as an Excel workbook (.xlsx).');
      if (file.size > vendorSheet.LIMITS.fileBytes) return await refuse(`The spreadsheet is larger than ${vendorSheet.LIMITS.fileBytes / 1048576} MB. Upload the file downloaded from this page.`);
      buffer = fs.readFileSync(file.path);
    } finally {
      removeFiles(staged);
    }
    let result;
    try {
      const parsed = await vendorSheet.parseUpload(buffer, await vendorSheet.pageFor(db, ctx));
      if (!parsed.posted) return res.redirect(303, `${req.vbase}?notice=sheet_same`);
      result = await vendorAnswers.saveAnswers(db, req.vkey, parsed.body, [], { person: req.vperson });
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        const errors = (err.errors || [err.message]).map(e => (e && e.stale ? { ...e, message: SHEET_STALE } : e));
        return renderQuestionnaire(req, res, ctx, { status: err.status, errors, view: 'start' });
      }
      throw err;
    }
    if (!result) return invalidPage(res);
    if (result.staged) removeFiles(result.staged);
    const notice = result.ai ? `ai_${result.ai}` : result.changed ? 'sheet_saved' : 'sheet_same';
    return res.redirect(303, `${req.vbase}?notice=${notice}`);
  }));

  async function renderIssues(req, res, vctx, { status = 200, errors = [], notice = null, values = null } = {}) {
    const p = await issues.vendorPage(db, vctx);
    const aft = aftFor(req, vctx.tokenHash);
    const count = await issues.vendorCount(db, vctx.workspaceId, vctx.assessmentId);
    const frame = await vendorPortal.frameFor(db, { firm: p.firm, session: req.vsession, person: req.vperson, workspaceId: vctx.workspaceId,
      thirdPartyId: vctx.thirdPartyId, active: req.vsession ? 'issues' : 'rissues',
      review: { base: req.vbase, issues: true, issuesWaiting: count.waiting, group: p.clientName ? `Questionnaire for ${p.clientName}` : null },
      linkHome: req.vsession || req.vfirm ? null : { action: `${req.vbase}/home`, aft } });
    return renderView(res, status, 'tprm_vendor_issues', {
      p, frame,
      token: req.vtoken,
      base: req.vbase,
      signedIn: req.vperson || null,
      aft,
      errors, notice, values,
      tpf: await datesFor(vctx.workspaceId),
    });
  }

  const issueContext = req => (req.vassessment ? issues.vendorContextFor(db, req.vassessment) : issues.vendorContext(db, req.vkey));

  async function renderContract(req, res, vctx, { status = 200, errors = [], notice = null, values = null } = {}) {
    const c = await contractChecklist.vendorPage(db, vctx);
    if (!c) return invalidPage(res);
    const p = await issues.vendorPage(db, vctx);
    const aft = aftFor(req, vctx.tokenHash);
    const frame = await vendorPortal.frameFor(db, { firm: p.firm, session: req.vsession, person: req.vperson, workspaceId: vctx.workspaceId,
      thirdPartyId: vctx.thirdPartyId, active: null, review: { base: req.vbase, label: 'Contract clauses' },
      linkHome: req.vsession || req.vfirm ? null : { action: `${req.vbase}/home`, aft } });
    return renderView(res, status, 'tprm_vendor_contract', {
      p, c, frame, labels: contractChecklist.VENDOR_STATUS_LABELS, statuses: contractChecklist.VENDOR_STATUSES,
      token: req.vtoken, base: req.vbase, signedIn: req.vperson || null, aft, errors, notice, values,
    });
  }

  vroute('get', 'i', '/contract', guarded(limiter, async (req, res) => {
    const vctx = await issueContext(req);
    if (!vctx) return invalidPage(res);
    return renderContract(req, res, vctx, { notice: req.query.notice === 'saved' ? 'Saved. You can change these until you send the questionnaire.' : req.query.notice === 'same' ? 'No changes to save.' : null });
  }));

  vroute('post', 'i', '/contract', guarded(postLimiter, async (req, res) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const vctx = await issueContext(req);
    if (!vctx) return invalidPage(res);
    if (isMultipart(req) || !aftOk(req, vctx.tokenHash)) return renderState(res, 403, 'forbidden');
    let result;
    try {
      result = await contractChecklist.vendorSave(db, vctx, req.body, { person: req.vperson });
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return renderContract(req, res, vctx, { status: err.status, errors: err.errors || [err.message], values: req.body.rows || null });
      if (err instanceof TprmError && err.status === 404) return invalidPage(res);
      throw err;
    }
    return res.redirect(303, `${req.vbase}/contract?notice=${result.changed ? 'saved' : 'same'}`);
  }));

  vroute('get', 'i', '/issues', guarded(limiter, async (req, res) => {
    const vctx = await issueContext(req);
    if (!vctx) return invalidPage(res);
    return renderIssues(req, res, vctx, { notice: req.query.notice === 'sent' ? 'Thank you: your response has been sent to the reviewers.' : null });
  }));

  vroute('post', 'i', '/issues/:iid', guarded(postLimiter, async (req, res) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const vctx = await issueContext(req);
    if (!vctx) return invalidPage(res);
    if (isMultipart(req) || !aftOk(req, vctx.tokenHash)) return renderState(res, 403, 'forbidden');
    const values = { issue: req.params.iid, body: String(req.body.body || '').slice(0, 5000), proposed_fix: String(req.body.proposed_fix || '').slice(0, 3000),
      proposed_date: String(req.body.proposed_date || '').slice(0, 20) };
    let result;
    try {
      result = await issues.vendorRespond(db, vctx, req.params.iid, req.body, { person: req.vperson });
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return renderIssues(req, res, vctx, { status: err.status, errors: err.errors || [err.message], values });
      if (err instanceof TprmError && err.status === 404) return invalidPage(res);
      throw err;
    }
    await messages.issueVendorReplied(db, { workspaceId: vctx.workspaceId, assessmentId: vctx.assessmentId, issueId: result.issueId });
    return res.redirect(303, `${req.vbase}/issues?notice=sent#issue-${result.issueId}`);
  }));

  async function renderConditions(req, res, ctx, { status = 200, errors = [], notice = null } = {}) {
    const p = await conditionLinks.pageData(db, ctx);
    const frame = await vendorPortal.frameFor(db, { firm: p.firm, session: req.vsession, person: req.vperson, workspaceId: ctx.workspaceId,
      thirdPartyId: ctx.thirdPartyId, active: null, review: { base: req.vbase, label: 'Conditions' } });
    return renderView(res, status, 'tprm_vendor_conditions', {
      p, frame,
      token: req.vtoken,
      base: req.vbase,
      signedIn: req.vperson || null,
      aft: aftFor(req, ctx.tokenHash),
      errors,
      notice,
      tpf: await datesFor(ctx.workspaceId),
    });
  }

  vroute('get', 'c', '', guarded(conditionsLimiter, async (req, res) => {
    const ctx = await conditionLinks.linkContext(db, req.vkey);
    if (!ctx) return invalidPage(res);
    return renderConditions(req, res, ctx, { notice: req.query.notice === 'sent' ? 'Thank you: your proof has been sent. The firm will review it.' : null });
  }));

  vroute('post', 'c', '/conditions/:cid/proof', guarded(conditionsPostLimiter, async (req, res, staged) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const ctx = await conditionLinks.linkContext(db, req.vkey);
    if (!ctx) return invalidPage(res);
    req.tprmVendor = ctx;
    const read = await readMultipart(req);
    staged.push(...read.files);
    if (read.error) return renderConditions(req, res, ctx, { status: 400, errors: [limitError(read.error)] });
    if (!aftOk(req, ctx.tokenHash)) {
      removeFiles(staged);
      return renderState(res, 403, 'forbidden');
    }
    const files = read.files;
    const fileProblem = files.some(f => f.fieldname !== 'files') ? 'The form could not be read. Nothing was saved: reload the page and try again.' : await checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderConditions(req, res, ctx, { status: 400, errors: [fileProblem] });
    }
    let result;
    try {
      result = await conditionLinks.submitProof(db, req.vkey, req.params.cid, files, req.body, { person: req.vperson });
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        const fresh = await conditionLinks.linkContext(db, req.vkey);
        if (!fresh) return invalidPage(res);
        return renderConditions(req, res, fresh, { status: err.status, errors: err.errors || [err.message] });
      }
      throw err;
    }
    if (!result) { removeFiles(staged); return invalidPage(res); }
    await messages.proofSubmitted(db, { workspaceId: result.ctx.workspaceId, assessmentId: result.ctx.assessmentId,
      proofId: result.proof.id, conditionId: result.condition.id });
    return res.redirect(303, `${req.vbase}?notice=sent`);
  }));

  const SIGN_IN_NOTICES = Object.freeze({ signed_out: 'You are signed out.', expired: 'Your session ended. Sign in again to continue.' });
  const HOME_NOTICES = Object.freeze({ closed: 'That questionnaire or conditions page is not open at the moment.' });
  const renderSignIn = (res, status, data) => renderView(res, status, 'tprm_vendor_signin', { step: 'email', email: '', errors: [], notice: null, firms: [], choice: null, codeId: null, minutes: vendorSession.LIMITS.codeMinutes, ...data });

  async function startSession(res, { firmId, email, personId = null, to = 'home' }) {
    const token = await vendorSession.createSession(db, { firmId, email, personId });
    res.set('Set-Cookie', vendorSession.cookieValue(token));
    return res.redirect(303, `${PORTAL}${['home', 'issues', 'files', 'people'].includes(to) ? to : 'home'}`);
  }

  async function linkSession(res, vctx, to) {
    const person = await vendorPeople.forLinkRecipient(db, { workspaceId: vctx.workspaceId, thirdPartyId: vctx.thirdPartyId, email: vctx.recipientEmail, name: vctx.recipientName });
    if (!person) return invalidPage(res);
    return startSession(res, { firmId: vctx.firmId, email: person.email, personId: Number(person.id), to });
  }

  app.get(`${PORTAL}sign-in`, guarded(limiter, async (req, res) => {
    const key = String(req.query.notice || '');
    return renderSignIn(res, 200, { notice: Object.prototype.hasOwnProperty.call(SIGN_IN_NOTICES, key) ? SIGN_IN_NOTICES[key] : null });
  }));

  app.post(`${PORTAL}sign-in`, guarded(signInLimiter, async (req, res) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    let r;
    try {
      r = await vendorSession.requestCode(db, req.body.email);
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) return renderSignIn(res, 400, { email: String(req.body.email || '').slice(0, 200), errors: err.errors || [err.message] });
      throw err;
    }
    if (r.sent) await messages.signInCode(db, { email: r.email, code: r.code, firmId: r.firm.id, firmName: r.firm.name, minutes: vendorSession.LIMITS.codeMinutes });
    return renderSignIn(res, 200, { step: 'code', email: r.email });
  }));

  app.post(`${PORTAL}verify`, guarded(signInLimiter, async (req, res) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const email = vendorSession.normEmail(req.body.email).slice(0, 200);
    const v = await vendorSession.verifyCode(db, email, req.body.code);
    if (!v) return renderSignIn(res, 400, { step: 'code', email, errors: ['That code is not right, or it has expired. Check the latest email we sent, or ask for a new code.'] });
    if (v.firms.length === 1) return startSession(res, { firmId: v.firms[0].id, email: v.email });
    return renderSignIn(res, 200, { step: 'choose', email: v.email, firms: v.firms, codeId: v.codeId, choice: vendorAnswers.formToken(`choose:${v.email}:${v.codeId}`) });
  }));

  app.post(`${PORTAL}choose`, guarded(signInLimiter, async (req, res) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const email = vendorSession.normEmail(req.body.email).slice(0, 200);
    const codeId = Number(req.body.code_id) || 0;
    if (!vendorAnswers.verifyFormToken(`choose:${email}:${codeId}`, req.body.choice) || !(await vendorSession.recentlyVerified(db, email, codeId))) {
      return renderSignIn(res, 400, { errors: ['That sign-in has expired. Ask for a new code.'] });
    }
    const firm = (await vendorSession.firmsFor(db, email)).find(f => f.id === Number(req.body.firm_id));
    if (!firm) return renderSignIn(res, 400, { errors: ['Choose one of the firms listed.'] });
    return startSession(res, { firmId: firm.id, email });
  }));

  async function renderHome(req, res, session, { status = 200, notice = null, errors = [], values = null, pageKey = 'home' } = {}) {
    const h = await vendorPortal.homeData(db, session);
    const frame = await vendorPortal.frameFor(db, { firm: h.firm, session, active: pageKey });
    return renderView(res, status, 'tprm_vendor_home', {
      h, frame, pageKey, aft: vendorAnswers.formToken(`home:${session.tokenHash}`), notice, errors, values,
      tpf: await datesFor(session.people[0].workspace_id), portal: PORTAL,
    });
  }
  const noticeOf = key => (Object.prototype.hasOwnProperty.call(HOME_NOTICES, key) ? HOME_NOTICES[key]
    : Object.prototype.hasOwnProperty.call(PORTAL_NOTICES, key) ? PORTAL_NOTICES[key] : null);
  const homeAftOk = (req, session) => vendorAnswers.verifyFormToken(`home:${session.tokenHash}`, req.body && req.body._aft);

  app.get(`${PORTAL}home`, guarded(limiter, async (req, res) => {
    const session = await sessionOf(req);
    if (!session) return res.redirect(303, `${PORTAL}sign-in${vendorSession.readCookie(req) ? '?notice=expired' : ''}`);
    return renderHome(req, res, session, { notice: noticeOf(String(req.query.notice || '')) });
  }));

  app.get(`${PORTAL}files`, guarded(limiter, async (req, res) => {
    const session = await sessionOf(req);
    if (!session) return res.redirect(303, `${PORTAL}sign-in`);
    const reviews = (await vendorPortal.filesData(db, session)).map(({ tokenHash, ...r }) => ({
      ...r, aft: tokenHash ? vendorAnswers.formToken(`${tokenHash}:${session.tokenHash}`) : null,
    }));
    const firm = await vendorPortal.firmBrand(db, session.firmId);
    const key = String(req.query.notice || '');
    return renderView(res, 200, 'tprm_vendor_files', {
      reviews, firm, frame: await vendorPortal.frameFor(db, { firm, session, active: 'files' }),
      notice: Object.prototype.hasOwnProperty.call(NOTICES, key) ? NOTICES[key] : null,
      limits: vendorAnswers.LIMITS, tpf: await datesFor(session.people[0].workspace_id),
    });
  }));

  for (const pageKey of ['issues', 'people']) {
    app.get(`${PORTAL}${pageKey}`, guarded(limiter, async (req, res) => {
      const session = await sessionOf(req);
      if (!session) return res.redirect(303, `${PORTAL}sign-in`);
      return renderHome(req, res, session, { pageKey, notice: noticeOf(String(req.query.notice || '')) });
    }));
  }

  async function homeAction(req, res, fn, { people = false } = {}) {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const session = await sessionOf(req);
    if (!session) return renderState(res, 403, 'signed_out');
    if (!homeAftOk(req, session)) return renderState(res, 403, 'forbidden');
    const me = session.people.find(p => p.id === Number(req.body && req.body.me));
    if (!me) return invalidPage(res);
    if (people && session.scopedTo) {
      return renderHome(req, res, session, { pageKey: 'people', status: 403, errors: ['To add, remove or hand over to people, sign in with a code sent to your email. Opening the questionnaire link is not enough.'] });
    }
    try {
      const notice = await fn(me);
      return res.redirect(303, `${PORTAL}people?notice=${notice}#people-${me.third_party_id}`);
    } catch (err) {
      if (err instanceof TprmError && [400, 403, 404, 409].includes(err.status)) {
        return renderHome(req, res, session, { pageKey: 'people', status: err.status === 404 ? 409 : err.status, errors: err.errors || [err.message], values: { for: me.id, ...req.body } });
      }
      throw err;
    }
  }

  app.post(`${PORTAL}people`, guarded(postLimiter, async (req, res) => homeAction(req, res, async me => {
    const added = await vendorPeople.vendorInvite(db, me, req.body);
    await messages.portalEmail(db, 'vendor_invited', { workspaceId: me.workspace_id, to: added,
      data: { inviterName: me.name, thirdPartyName: me.third_party_name }, key: `vendor_invited:${added.id}` });
    return 'invited';
  }, { people: true })));

  app.post(`${PORTAL}people/:pid/remove`, guarded(postLimiter, async (req, res) => homeAction(req, res, async me => {
    await vendorPeople.vendorRemove(db, me, req.params.pid);
    return 'removed';
  }, { people: true })));

  app.post(`${PORTAL}people/:pid/main`, guarded(postLimiter, async (req, res) => homeAction(req, res, async me => {
    await vendorPeople.vendorHandOver(db, me, req.params.pid);
    return 'handed_over';
  }, { people: true })));

  app.post(`${PORTAL}me`, guarded(postLimiter, async (req, res) => homeAction(req, res, async me => {
    await vendorPeople.vendorUpdateSelf(db, me, req.body);
    return 'details_saved';
  })));

  app.post(`${PORTAL}a/:aid/assign`, fromSession('q'), guarded(postLimiter, async (req, res) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const ctx = await vendorAnswers.linkContext(db, req.vkey);
    if (!ctx || ctx.mode !== 'answering') return invalidPage(res);
    if (isMultipart(req) || !aftOk(req, ctx.tokenHash)) return renderState(res, 403, 'forbidden');
    let result;
    try {
      result = await vendorPeople.assignSections(db, req.vperson, ctx.assessmentId, (await vendorAnswers.sectionList(db, ctx)).map(s => s.title), req.body);
    } catch (err) {
      if (err instanceof TprmError && [400, 403, 404].includes(err.status)) return renderQuestionnaire(req, res, ctx, { status: err.status === 404 ? 400 : err.status, errors: err.errors || [err.message], view: 'start' });
      throw err;
    }
    const byPerson = new Map();
    for (const n of result.newly) {
      if (Number(n.person.id) === req.vperson.id) continue;
      if (!byPerson.has(n.person.id)) byPerson.set(n.person.id, { person: n.person, sections: [] });
      byPerson.get(n.person.id).sections.push(n.title);
    }
    for (const { person, sections } of byPerson.values()) {
      await messages.portalEmail(db, 'vendor_sections_assigned', { workspaceId: ctx.workspaceId, to: person,
        data: { inviterName: req.vperson.name, sections }, key: `vendor_sections:${ctx.assessmentId}:${person.id}:${sections.join('|').length}:${Date.now()}` });
    }
    return res.redirect(303, `${req.vbase}?notice=assigned#who-answers`);
  }));

  app.post(`${PORTAL}sign-out`, guarded(postLimiter, async (req, res) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const session = await sessionOf(req);
    if (session && homeAftOk(req, session)) await vendorSession.endSession(db, vendorSession.readCookie(req));
    else if (session) return renderState(res, 403, 'forbidden');
    res.set('Set-Cookie', vendorSession.cookieValue(null));
    return res.redirect(303, `${PORTAL}sign-in?notice=signed_out`);
  }));

  app.post(`${PREFIX}:token/home`, guarded(postLimiter, async (req, res) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const vctx = await issues.vendorContext(db, req.params.token);
    if (!vctx) return invalidPage(res);
    if (isMultipart(req) || !vendorAnswers.verifyFormToken(vctx.tokenHash, req.body && req.body._aft)) return renderState(res, 403, 'forbidden');
    return linkSession(res, vctx, String((req.body && req.body.to) || 'home'));
  }));

  app.all(`${PORTAL}*`, guarded(limiter, async (_req, res) => invalidPage(res)));
  app.all(`${CONDITIONS_PREFIX}*`, guarded(conditionsLimiter, async (_req, res) => invalidPage(res)));
  app.all(`${PREFIX}*`, guarded(limiter, async (_req, res) => invalidPage(res)));
}

function goTarget(value) {
  const v = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  if (['start', 'review', 'documents', 'issues', 'contract', 'home', 'pissues', 'people', 'files'].includes(v)) return v;
  return /^[A-Z]{2,6}-[0-9]{1,4}$/.test(v) ? v : null;
}

function safeValues(body) {
  const out = {};
  const group = k => (body && typeof body[k] === 'object' && body[k]) || {};
  const s = v => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v)).slice(0, 4000);
  const blank = () => ({ response: '', detail: '', answer_text: '', fields: {}, yes_details: '', evidence_ref: '', evidence_date: '', confirm: false });
  for (const k of ['r', 'd', 't', 'ref', 'date', 'y']) {
    for (const id of Object.keys(group(k))) {
      if (!/^[A-Z]{2,6}-[0-9]{1,4}$/.test(id)) continue;
      out[id] = out[id] || blank();
      out[id][{ r: 'response', d: 'detail', t: 'answer_text', ref: 'evidence_ref', date: 'evidence_date', y: 'yes_details' }[k]] = s(group(k)[id]);
    }
  }
  for (const id of Object.keys(group('f'))) {
    const posted = group('f')[id];
    if (!/^[A-Z]{2,6}-[0-9]{1,4}$/.test(id) || !posted || typeof posted !== 'object' || Array.isArray(posted)) continue;
    out[id] = out[id] || blank();
    for (const key of Object.keys(posted).slice(0, 10)) if (/^[a-z0-9_]{1,40}$/.test(key)) out[id].fields[key] = s(posted[key]).slice(0, 1500);
  }
  return out;
}

module.exports = { register: registerRoutes, registerFirm: registerFirmRoutes, FIRM_PATH, goTarget, bodyGuard, limiter, postLimiter, signInLimiter, conditionsLimiter, conditionsPostLimiter, RATE_LIMIT, POST_RATE_LIMIT, INVALID_STATUS, BODY_LIMITS, NOTICES };
