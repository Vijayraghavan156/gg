'use strict';

const fs = require('fs');
const contentDisposition = require('content-disposition');
const { withToast, auditCtx } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const report = require('../lib/tprm/report');
const letterhead = require('../lib/tprm/letterhead');
const { TprmError } = require('../lib/tprm/errors');

const NOT_FOUND = 'This report does not exist, or it is not available to your account.';
const LETTERHEAD = '/tprm/settings/letterhead';

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, getWorkspace, permissionsFor, listWorkspaces, logAction, upload } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };

  function sendPdf(res, out) {
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', contentDisposition(out.filename));
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(out.pdf);
  }

  function renderError(req, res, err, next, extra = {}) {
    if (err instanceof TprmError) {
      return res.status(err.status >= 400 && err.status < 600 ? err.status : 500).render('error', { user: req.user, ...extra, message: err.message });
    }
    return next(err);
  }

  app.get('/tprm/clients/:wsId/third-parties/:tpId/assessments/:aid/recommendations/:rid/report.pdf', requireAuth, async (req, res, next) => {
    try {
      const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
      if (!loaded) return res.status(404).render('error', { user: req.user, message: NOT_FOUND });
      const out = await report.generate(db, {
        ws: loaded.ws, recommendationId: req.params.rid, actorId: req.user.id, audience: 'firm',
        expect: { thirdPartyId: req.params.tpId, assessmentId: req.params.aid },
      });
      return sendPdf(res, out);
    } catch (err) {
      return renderError(req, res, err, next);
    }
  });

  app.get('/workspaces/:wsId/client-portal/third-party-risk/recommendations/:rid/report.pdf', requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      if (!access.isClientUser(req.user) || res.locals.tpPortalEnabled !== true) {
        return res.status(404).render('error', { user: req.user, ws: req.workspace, message: NOT_FOUND });
      }
      const out = await report.generate(db, { ws: req.workspace, recommendationId: req.params.rid, actorId: req.user.id, audience: 'client' });
      await logAction(req.user.id, req.workspace.id, 'tprm_client_download_recommendation_report', 'tp_recommendation', Number(req.params.rid),
        { sha256: out.sha256 }, auditCtx(req));
      return sendPdf(res, out);
    } catch (err) {
      return renderError(req, res, err, next, { ws: req.workspace });
    }
  });

  const forbidden = (req, res) => res.status(403).render('error', {
    user: req.user, message: 'The firm\'s letterhead can be changed by managers only.',
  });
  const isManagerUser = user => access.isFirmUser(user) && !!user.firm_id && access.firmCan(user, letterhead.SETTINGS_PERMISSION);
  const requireSettings = (req, res, next) => (isManagerUser(req.user) ? next() : forbidden(req, res));

  const keptValues = body => {
    const b = body || {};
    const pick = k => (typeof b[k] === 'string' ? b[k] : '');
    return { display_name: pick('display_name'), address_lines: pick('address_lines'), contact_line: pick('contact_line'), footer_text: pick('footer_text'), brand_colour: pick('brand_colour') };
  };
  async function renderForm(req, res, { status = 200, values = null, errors = [], field = null } = {}) {
    const lh = await letterhead.getLetterhead(db, req.user.firm_id);
    return res.status(status).render('tprm_settings_letterhead', {
      user: req.user,
      active: 'tprm-portfolio',
      lh,
      values: values || { display_name: lh.customName, address_lines: lh.addressLines.join('\n'), contact_line: lh.contactLine, footer_text: lh.footerText, brand_colour: lh.brandColour || '' },
      errors,
      errorField: field,
      limits: letterhead.LIMITS,
      logoUri: lh.logo ? await letterhead.logoDataUri(db, req.user.firm_id) : null,
    });
  }

  app.get(LETTERHEAD, requireAuth, requireSettings, async (req, res) => renderForm(req, res));

  const logoUpload = upload.single('logo');
  function acceptLogo(req, res, next) {
    logoUpload(req, res, err => {
      if (!err) return next();
      if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      if (typeof err.code === 'string' && err.code.startsWith('LIMIT_')) {
        return renderForm(req, res, { status: 400, values: keptValues(req.body), errors: [err.code === 'LIMIT_FILE_SIZE'
          ? 'The logo is larger than the upload limit. Nothing was saved: choose a smaller file.' : 'The upload could not be read. Nothing was saved: choose the file again.'], field: 'logo' });
      }
      return next(err);
    });
  }

  app.post(LETTERHEAD, requireAuth, requireSettings, acceptLogo, async (req, res, next) => {
    const staged = req.file || null;
    try {
      const result = await letterhead.saveLetterhead(db, req.user, req.body || {}, staged);
      if (result.changed) {
        await logAction(req.user.id, null, 'tprm_letterhead_changed', 'firm', Number(req.user.firm_id),
          { fields: result.fields, logo_sha256: result.letterhead.logo ? result.letterhead.logo.sha256 : null }, auditCtx(req));
      }
      return res.redirect(withToast(LETTERHEAD, result.changed ? 'Letterhead saved' : 'No changes to save'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        const errors = err.errors || [err.message];
        const field = errors.some(e => /brand colour/i.test(e)) ? 'brand_colour' : errors.some(e => /logo/i.test(e)) ? 'logo' : null;
        return renderForm(req, res, { status: 400, values: keptValues(req.body), errors, field });
      }
      if (err instanceof TprmError && err.status === 409) return renderForm(req, res, { status: 409, values: keptValues(req.body), errors: [err.message] });
      if (err instanceof TprmError && err.status === 403) return forbidden(req, res);
      return next(err);
    } finally {
      if (staged && staged.path) { try { fs.unlinkSync(staged.path); } catch (_) {} }
    }
  });
}

module.exports = { register, LETTERHEAD };
