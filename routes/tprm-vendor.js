'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const questionnaires = require('../lib/tprm/questionnaires');
const vendorAnswers = require('../lib/tprm/vendor-answers');
const conditionLinks = require('../lib/tprm/condition-links');
const messages = require('../lib/tprm/messages');
const uploadSecurity = require('../lib/upload-security');
const { createFixedWindowLimiter } = require('../lib/rate-limit');
const { TprmError } = require('../lib/tprm/errors');
const format = require('../lib/tprm/format');
const { ymdInZone } = require('../lib/dates');

const RATE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 120 });
const POST_RATE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 60 });
const limiter = createFixedWindowLimiter(RATE_LIMIT);
const postLimiter = createFixedWindowLimiter(POST_RATE_LIMIT);
const conditionsLimiter = createFixedWindowLimiter(RATE_LIMIT);
const conditionsPostLimiter = createFixedWindowLimiter(POST_RATE_LIMIT);
const CONDITIONS_PREFIX = conditionLinks.LINK_PATH;
const INVALID_STATUS = 404;
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const PREFIX = questionnaires.LINK_PATH;
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
});

function publicHeaders(res) {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
}

const isPost = req => req.method === 'POST' && typeof req.path === 'string' && (req.path.startsWith(PREFIX) || req.path.startsWith(conditionLinks.LINK_PATH));
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

function removeFiles(files) {
  for (const file of files || []) {
    try { if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) {}
  }
}

const smallForm = express.urlencoded({ extended: true, limit: BODY_LIMITS.formBytes, parameterLimit: 50 });

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
    const dir = path.join(UPLOADS_ROOT, `firm_${Number(req.tprmVendor.firmId) || 0}`);
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

function registerRoutes(app, { db }) {
  const page = (res, status, data) => renderView(res, status, 'tprm_vendor_questionnaire', data);

  async function datesFor(workspaceId) {
    const row = Number(workspaceId) ? await db.prepare(`SELECT w.timezone, f.timezone AS firm_timezone FROM workspaces w
      LEFT JOIN firms f ON f.id = w.firm_id WHERE w.id = ?`).get(Number(workspaceId)) : null;
    return format.forZone(format.zoneOf({ timezone: row && row.timezone }, { timezone: row && row.firm_timezone }), { ymdInZone });
  }
  async function datesForToken(token) {
    return datesFor(await questionnaires.linkWorkspaceId(db, token));
  }

  async function renderQuestionnaire(req, res, ctx, { status = 200, values = null, errors = [], notice = null, view = null, section = null,
    reportValues = null } = {}) {
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
    return page(res, status, {
      p: data,
      token: req.params.token,
      aft: vendorAnswers.formToken(ctx.tokenHash),
      notice,
      errors,
      view: shown,
      section: shown === 'section' ? data.sections[index - 1] : null,
      reportValues,
      tpf: await datesFor(ctx.workspaceId),
    });
  }

  const sectionParam = value => {
    const n = Number(String(value || ''));
    return Number.isSafeInteger(n) && n >= 1 && n <= 500 ? n : null;
  };

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
    const ctx = await vendorAnswers.linkContext(db, req.params.token);
    if (!ctx || !modes.includes(ctx.mode)) { await invalidPage(res); return null; }
    req.tprmVendor = ctx;
    const read = await readMultipart(req);
    staged.push(...read.files);
    if (read.error) {
      if (ctx.mode === 'answering') {
        const section = view === 'section' ? sectionParam(req.body && req.body.section) : null;
        await renderQuestionnaire(req, res, ctx, { status: 400, errors: [limitError(read.error)], view: section ? 'section' : null, section });
      }
      else await renderState(res, 400, 'too_large');
      return null;
    }
    if (!vendorAnswers.verifyFormToken(ctx.tokenHash, req.body && req.body._aft)) {
      removeFiles(staged);
      await renderState(res, 403, 'forbidden');
      return null;
    }
    return { ctx, files: read.files };
  }

  function checkFiles(files) {
    if (files.length > vendorAnswers.LIMITS.filesPerRequest) {
      return `Attach at most ${vendorAnswers.LIMITS.filesPerRequest} files each time you save. Nothing was saved: choose fewer files and save again.`;
    }
    for (const file of files) {
      const result = uploadSecurity.validateUpload(file, uploadSecurity.GENERAL_UPLOAD_EXTENSIONS);
      if (!result.ok) return `${String(file.originalname || 'A file').slice(0, 120)}: ${result.message || 'the file did not pass the upload checks.'} Nothing was saved.`;
    }
    return null;
  }

  app.get(`${PREFIX}:token`, guarded(limiter, async (req, res) => {
    const ctx = await vendorAnswers.linkContext(db, req.params.token);
    if (!ctx) {
      const done = await vendorAnswers.submittedLink(db, req.params.token);
      if (done) return renderState(res, 200, 'submitted', { ...done, tpf: await datesForToken(req.params.token) });
      return invalidPage(res);
    }
    const key = String(req.query.notice || '');
    const notice = Object.prototype.hasOwnProperty.call(NOTICES, key) ? NOTICES[key] : null;
    const section = sectionParam(req.query.s);
    const view = ctx.mode === 'clarifying' ? 'clarify' : req.query.view === 'review' ? 'confirm'
      : req.query.view === 'documents' ? 'documents' : section ? 'section' : 'start';
    return renderQuestionnaire(req, res, ctx, { notice, view, section });
  }));

  app.post(`${PREFIX}:token/save`, guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged, { view: 'section' });
    if (!pre) return undefined;
    const { ctx, files } = pre;
    const posted = sectionParam(req.body.section);
    const fileProblem = checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: [fileProblem], values: safeValues(req.body), view: 'section', section: posted });
    }
    let result;
    try {
      result = await vendorAnswers.saveAnswers(db, req.params.token, req.body, files);
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        const errors = err.errors || [err.message];
        return renderQuestionnaire(req, res, ctx, { status: err.status, errors, values: err.values || null, view: 'section', section: posted });
      }
      throw err;
    }
    if (!result) { removeFiles(staged); return invalidPage(res); }
    removeFiles(result.staged);
    for (const stored of result.removedPaths) {
      removeFiles([{ path: path.join(UPLOADS_ROOT, `firm_${ctx.firmId}`, path.basename(stored)) }]);
    }
    if (req.body.intent === 'review') {
      const fresh = await vendorAnswers.linkContext(db, req.params.token);
      if (!fresh) return invalidPage(res);
      return renderQuestionnaire(req, res, fresh, { view: 'confirm' });
    }
    const notice = result.ai ? `ai_${result.ai}` : 'saved';
    const go = goTarget(req.body.go);
    if (go) {
      const here = `${PREFIX}${req.params.token}`;
      if (go === 'start') return res.redirect(303, `${here}?notice=${notice}`);
      if (go === 'review') return res.redirect(303, `${here}?view=review&notice=${notice}`);
      if (go === 'documents') return res.redirect(303, `${here}?view=documents&notice=${notice}`);
      const sections = await vendorAnswers.sectionList(db, ctx);
      let index = sections.findIndex(s => (s.ids || []).includes(go)) + 1;
      if (!index) index = Math.min(Math.max(posted || 1, 1), sections.length);
      if (!index) return res.redirect(303, `${here}?view=review&notice=${notice}`);
      return res.redirect(303, `${here}?s=${index}&notice=${notice}`);
    }
    if (!posted) {
      const anchor = result.ai === 'added' ? '#ai-services' : '';
      return res.redirect(303, `${PREFIX}${req.params.token}?notice=${notice}${anchor}`);
    }
    if (req.body.intent === 'next') {
      const count = await vendorAnswers.sectionCount(db, ctx);
      if (posted >= count) return res.redirect(303, `${PREFIX}${req.params.token}?view=review&notice=${notice}`);
      return res.redirect(303, `${PREFIX}${req.params.token}?s=${posted + 1}&notice=${notice}`);
    }
    return res.redirect(303, `${PREFIX}${req.params.token}?s=${posted}&notice=${notice}`);
  }));

  app.post(`${PREFIX}:token/reports`, guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged);
    if (!pre) return undefined;
    const { ctx, files } = pre;
    const fileProblem = files.length > 3 ? 'Attach at most three files to a report.' : checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: [fileProblem], view: 'start' });
    }
    let result;
    try {
      result = await vendorAnswers.saveReport(db, req.params.token, req.body, files);
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
      removeFiles([{ path: path.join(UPLOADS_ROOT, `firm_${ctx.firmId}`, path.basename(stored)) }]);
    }
    const notice = result.outcome === 'added' ? 'report_added' : result.outcome === 'removed' ? 'report_removed' : 'report_updated';
    return res.redirect(303, `${PREFIX}${req.params.token}?notice=${notice}#reports`);
  }));

  app.post(`${PREFIX}:token/documents`, guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged);
    if (!pre) return undefined;
    const { ctx, files } = pre;
    const fileProblem = checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: [fileProblem], view: 'documents' });
    }
    let result;
    try {
      result = await vendorAnswers.addDocuments(db, req.params.token, req.body, files);
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return renderQuestionnaire(req, res, ctx, { status: err.status, errors: err.errors || [err.message], view: 'documents' });
      }
      throw err;
    }
    if (!result) { removeFiles(staged); return invalidPage(res); }
    removeFiles(result.staged);
    return res.redirect(303, `${PREFIX}${req.params.token}?view=documents&notice=${result.added ? 'documents_added' : 'documents_same'}`);
  }));

  app.post(`${PREFIX}:token/documents/:eid`, guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged);
    if (!pre) return undefined;
    removeFiles(staged);
    let result;
    try {
      result = await vendorAnswers.updateDocument(db, req.params.token, req.params.eid, req.body);
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return renderQuestionnaire(req, res, pre.ctx, { status: err.status, errors: err.errors || [err.message], view: 'documents' });
      }
      throw err;
    }
    if (!result) return invalidPage(res);
    if (result.path) removeFiles([{ path: path.join(UPLOADS_ROOT, `firm_${pre.ctx.firmId}`, path.basename(result.path)) }]);
    return res.redirect(303, `${PREFIX}${req.params.token}?view=documents&notice=${result.deleted ? 'document_deleted' : 'document_saved'}`);
  }));

  app.post(`${PREFIX}:token/submit`, guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged);
    if (!pre) return undefined;
    removeFiles(staged);
    const result = await vendorAnswers.submit(db, req.params.token);
    if (!result) return invalidPage(res);
    if (result.problems) return renderQuestionnaire(req, res, pre.ctx, { status: 409, view: 'confirm' });
    await messages.vendorSubmitted(db, result);
    return renderState(res, 200, 'submitted', { clientName: result.clientName, submittedAt: result.submittedAt, tpf: await datesFor(pre.ctx.workspaceId) });
  }));

  app.post(`${PREFIX}:token/clarifications/:cid`, guarded(postLimiter, async (req, res, staged) => {
    const pre = await postPreamble(req, res, staged, { modes: ['answering', 'clarifying'] });
    if (!pre) return undefined;
    const { ctx, files } = pre;
    if (files.length > 1 || files.some(f => f.fieldname !== 'file')) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: ['Attach at most one file to a response.'], view: 'clarify' });
    }
    const fileProblem = checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderQuestionnaire(req, res, ctx, { status: 400, errors: [fileProblem], view: 'clarify' });
    }
    let result;
    try {
      result = await vendorAnswers.answerClarification(db, req.params.token, req.params.cid, req.body, files[0] || null);
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
    return res.redirect(303, `${PREFIX}${req.params.token}?notice=answered`);
  }));

  async function renderConditions(req, res, ctx, { status = 200, errors = [], notice = null } = {}) {
    return renderView(res, status, 'tprm_vendor_conditions', {
      p: await conditionLinks.pageData(db, ctx),
      token: req.params.token,
      aft: vendorAnswers.formToken(ctx.tokenHash),
      errors,
      notice,
      tpf: await datesFor(ctx.workspaceId),
    });
  }

  app.get(`${CONDITIONS_PREFIX}:token`, guarded(conditionsLimiter, async (req, res) => {
    const ctx = await conditionLinks.linkContext(db, req.params.token);
    if (!ctx) return invalidPage(res);
    return renderConditions(req, res, ctx, { notice: req.query.notice === 'sent' ? 'Thank you: your proof has been sent. The firm will review it.' : null });
  }));

  app.post(`${CONDITIONS_PREFIX}:token/conditions/:cid/proof`, guarded(conditionsPostLimiter, async (req, res, staged) => {
    if (!sameOrigin(req)) return renderState(res, 403, 'forbidden');
    const ctx = await conditionLinks.linkContext(db, req.params.token);
    if (!ctx) return invalidPage(res);
    req.tprmVendor = ctx;
    const read = await readMultipart(req);
    staged.push(...read.files);
    if (read.error) return renderConditions(req, res, ctx, { status: 400, errors: [limitError(read.error)] });
    if (!vendorAnswers.verifyFormToken(ctx.tokenHash, req.body && req.body._aft)) {
      removeFiles(staged);
      return renderState(res, 403, 'forbidden');
    }
    const files = read.files;
    const fileProblem = files.some(f => f.fieldname !== 'files') ? 'The form could not be read. Nothing was saved: reload the page and try again.' : checkFiles(files);
    if (fileProblem) {
      removeFiles(staged);
      return renderConditions(req, res, ctx, { status: 400, errors: [fileProblem] });
    }
    let result;
    try {
      result = await conditionLinks.submitProof(db, req.params.token, req.params.cid, files, req.body);
    } catch (err) {
      removeFiles(staged);
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        const fresh = await conditionLinks.linkContext(db, req.params.token);
        if (!fresh) return invalidPage(res);
        return renderConditions(req, res, fresh, { status: err.status, errors: err.errors || [err.message] });
      }
      throw err;
    }
    if (!result) { removeFiles(staged); return invalidPage(res); }
    await messages.proofSubmitted(db, { workspaceId: result.ctx.workspaceId, assessmentId: result.ctx.assessmentId,
      proofId: result.proof.id, conditionId: result.condition.id });
    return res.redirect(303, `${CONDITIONS_PREFIX}${req.params.token}?notice=sent`);
  }));

  app.all(`${CONDITIONS_PREFIX}*`, guarded(conditionsLimiter, async (_req, res) => invalidPage(res)));
  app.all(`${PREFIX}*`, guarded(limiter, async (_req, res) => invalidPage(res)));
}

function goTarget(value) {
  const v = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  if (v === 'start' || v === 'review' || v === 'documents') return v;
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

module.exports = { register: registerRoutes, goTarget, bodyGuard, limiter, postLimiter, conditionsLimiter, conditionsPostLimiter, RATE_LIMIT, POST_RATE_LIMIT, INVALID_STATUS, BODY_LIMITS, NOTICES };
