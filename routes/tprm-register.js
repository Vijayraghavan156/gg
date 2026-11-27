'use strict';

const { withToast, auditCtx } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const register = require('../lib/tprm/register');
const assessments = require('../lib/tprm/assessments');
const decisions = require('../lib/tprm/decisions');
const tpImport = require('../lib/tprm/import');
const clientSettings = require('../lib/tprm/client-settings');
const tpSettings = require('../lib/tprm/settings');
const placement = require('../lib/tprm/placement');
const vendorPeople = require('../lib/tprm/vendor-people');
const team = require('../lib/tprm/team');
const { TprmError } = require('../lib/tprm/errors');

const NOT_FOUND = 'This third-party risk client does not exist, or it is not available to your account.';

function clientView(ws) {
  return { id: ws.id, name: ws.brand_display_name || ws.client_name, sector: ws.sector || null };
}

function registerRoutes(app, deps) {
  const { db, requireAuth, getWorkspace, permissionsFor, listWorkspaces, logAction, csvUpload } = deps;
  const lookup = { db, getWorkspace, permissionsFor, listWorkspaces };
  const base = actor => `/tprm/clients/${actor.ws.id}`;

  function renderPage(req, res, view, actor, locals = {}, status = 200) {
    return res.status(status).render(view, {
      user: req.user,
      active: 'tprm-portfolio',
      tpClient: clientView(actor.ws),
      tp: placement,
      canManage: access.can(req.user, actor.perms, 'tp.manage'),
      canSettings: access.can(req.user, actor.perms, 'tp.settings'),
      ...locals,
    });
  }

  function fail(req, res, err) {
    if (!(err instanceof TprmError)) throw err;
    const message = err.status === 404 ? (err.message || NOT_FOUND) : err.message;
    return res.status(err.status).render('error', { user: req.user, message });
  }

  function handler(fn, { permission = 'tp.view' } = {}) {
    return async (req, res, next) => {
      try {
        const loaded = await access.loadFirmWorkspace(lookup, req.user, req.params.wsId);
        if (!loaded) return res.status(404).render('error', { user: req.user, message: NOT_FOUND });
        const actor = { user: req.user, perms: loaded.perms, ws: loaded.ws };
        if (permission !== 'tp.view' && !access.can(req.user, actor.perms, permission)) {
          return res.status(403).render('error', {
            user: req.user,
            message: permission === 'tp.settings'
              ? 'Only a manager can change third-party risk settings for this client.'
              : 'Your role does not allow changes to this client\'s third parties.',
          });
        }
        return await fn(req, res, actor);
      } catch (err) {
        if (err instanceof TprmError) return fail(req, res, err);
        return next(err);
      }
    };
  }

  async function renderThirdPartyForm(req, res, actor, { thirdParty = null, values = {}, errors = [], duplicates = [], status = 200 }) {
    const settings = await clientSettings.get(db, actor.ws.id);
    return renderPage(req, res, 'tprm_third_party_form', actor, {
      thirdParty, values, errors, duplicates,
      labels: Object.keys(settings.label_tier_map || {}),
      clientPeople: await register.clientPeople(db, actor.ws.id),
      formAction: thirdParty ? `${base(actor)}/third-parties/${thirdParty.id}` : `${base(actor)}/third-parties`,
    }, status);
  }

  async function saveThirdParty(req, res, actor, thirdParty) {
    const confirmDuplicate = req.body.confirm_duplicate === '1';
    const firstService = !thirdParty && req.body.first_service === '1' ? req.body : null;
    try {
      const result = thirdParty
        ? await register.updateThirdParty(db, actor, thirdParty.id, req.body, { confirmDuplicate })
        : await register.createThirdParty(db, actor, req.body, { confirmDuplicate, firstService });
      if (result.needsConfirmation) {
        return await renderThirdPartyForm(req, res, actor, { thirdParty, values: req.body, duplicates: result.duplicates, status: 200 });
      }
      const saved = result.thirdParty;
      const added = result.service ? 'Third party and its first service added' : 'Third party added';
      const message = thirdParty
        ? (result.unchanged ? 'No changes to save' : result.cancelledAssessment ? 'Third party marked exited and its open assessment cancelled' : 'Third party updated')
        : (result.duplicates.length ? `${added}. Another third party has the same name; check it is not a duplicate` : added);
      return res.redirect(withToast(`${base(actor)}/third-parties/${saved.id}`, message,
        !thirdParty && result.duplicates.length ? 'warn' : undefined));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return await renderThirdPartyForm(req, res, actor, { thirdParty, values: req.body, errors: err.errors || [err.message], status: 400 });
      }
      throw err;
    }
  }

  app.get('/tprm/clients/:wsId/third-parties/new', requireAuth, handler(async (req, res, actor) =>
    renderThirdPartyForm(req, res, actor, { values: { status: 'in_use' } }), { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/third-parties', requireAuth, handler(async (req, res, actor) =>
    saveThirdParty(req, res, actor, null), { permission: 'tp.manage' }));

  async function renderThirdParty(req, res, actor, thirdParty, extra = {}, status = 200) {
    const [services, history, sameNamed] = await Promise.all([
      register.listServices(db, actor, thirdParty.id),
      register.recentEvents(db, actor, thirdParty.id),
      register.sameNamed(db, actor.ws.id, thirdParty.name, thirdParty.id),
    ]);
    const duplicates = await require('../lib/tprm/scope').keep(db, actor.user, sameNamed.map(d => ({ ...d, workspace_id: actor.ws.id })), { tp: 'id' });
    return renderPage(req, res, 'tprm_third_party', actor, {
      thirdParty, services, history, duplicates, today: register.today(actor),
      party: await require('../lib/tprm/firm-party').build(db, actor.ws, thirdParty.id),
      clientOwner: thirdParty.client_owner_user_id ? (await register.clientPeople(db, actor.ws.id)).find(u => Number(u.id) === Number(thirdParty.client_owner_user_id)) || null : null,
      serviceErrors: [], serviceValues: {},
      assessmentList: await assessments.listForThirdParty(db, actor, thirdParty.id), at: assessments,
      approval: await decisions.currentApproval(db, actor.ws, thirdParty.id),
      stage: (await require('../lib/tprm/pipeline').stagesForClient(db, actor.ws.id)).get(Number(thirdParty.id)) || null,
      tab: req.query && typeof req.query.tab === 'string' ? req.query.tab : null,
      ...extra,
      peoplePanel: { list: await vendorPeople.list(db, actor.ws.id, thirdParty.id), openLinks: await vendorPeople.withOpenLinks(db, actor.ws.id, thirdParty.id), labels: vendorPeople.ROLE_LABELS, errors: [], values: {}, editErrors: {}, ...(extra.peoplePanel || {}) },
      teamPanel: { team: await team.forThirdParty(db, actor.ws.id, thirdParty.id), people: await team.candidates(db, actor.ws), reviewers: await team.reviewerCandidates(db, actor.ws), errors: [], ...(extra.teamPanel || {}) },
    }, status);
  }

  app.post('/tprm/clients/:wsId/third-parties/:tpId/team', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    try {
      const result = await team.set(db, actor, thirdParty.id, req.body);
      return res.redirect(withToast(`${base(actor)}/third-parties/${thirdParty.id}#team`, result.unchanged ? 'Nothing changed' : 'Team saved'));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderThirdParty(req, res, actor, thirdParty, { teamPanel: { errors: err.errors || [err.message], open: true } }, 400);
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/third-parties/bulk-start', requireAuth, handler(async (req, res, actor) => {
    const raw = req.body && req.body.ids;
    const ids = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0))].slice(0, 50);
    if (!ids.length) return res.redirect(withToast(base(actor), 'Tick at least one third party first.', 'error'));
    let started = 0;
    const skipped = [];
    for (const id of ids) {
      try {
        const tp = await register.getThirdParty(db, actor, id);
        await assessments.start(db, actor, tp.id);
        started += 1;
      } catch (err) {
        if (!(err instanceof TprmError)) throw err;
        skipped.push(err.status === 404 ? 'one that was not found' : err.message.replace(/\.$/, ''));
      }
    }
    if (started) await logAction(req.user.id, actor.ws.id, 'tprm_bulk_assessments_started', 'workspace', actor.ws.id, { started, asked: ids.length }, auditCtx(req));
    const msg = `${started} assessment${started === 1 ? '' : 's'} started` + (skipped.length ? `. ${skipped.length} not started: ${[...new Set(skipped)].join('; ')}` : '');
    return res.redirect(withToast(base(actor), msg, started ? undefined : 'error'));
  }, { permission: 'tp.manage' }));

  const bulkIds = req => [...new Set((Array.isArray(req.body.ids) ? req.body.ids : req.body.ids ? [req.body.ids] : []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0))].slice(0, 50);
  const openAssessmentOf = async (actor, tpId) => assessments.openAssessment(db, actor.ws.id, tpId);

  app.post('/tprm/clients/:wsId/third-parties/bulk-remind', requireAuth, handler(async (req, res, actor) => {
    const ids = bulkIds(req);
    if (!ids.length) return res.redirect(withToast(base(actor), 'Tick at least one third party first.', 'error'));
    let sent = 0;
    const why = [];
    const went = [];
    for (const id of ids) {
      try {
        const tp = await register.getThirdParty(db, actor, id);
        const open = await openAssessmentOf(actor, tp.id);
        if (!open) { why.push(`${tp.name}: no review open`); continue; }
        const r = await require('../lib/tprm/messages').manualReminder(db, { workspaceId: actor.ws.id, assessmentId: Number(open.id), actorId: req.user.id, actorName: req.user.name });
        if (r.sent) { sent += 1; went.push(`${tp.name} to ${r.recipient || 'the third party'}`); } else why.push(`${tp.name}: ${r.recipientEmail ? String(r.reason).split(r.recipientEmail).join(r.recipient || 'the recipient') : r.reason}`);
      } catch (err) {
        if (!(err instanceof TprmError)) throw err;
        why.push('one that was not found');
      }
    }
    if (sent) await logAction(req.user.id, actor.ws.id, 'tprm_bulk_reminders_sent', 'workspace', actor.ws.id, { sent, asked: ids.length }, auditCtx(req));
    return res.redirect(withToast(base(actor), `${sent} reminder${sent === 1 ? '' : 's'} sent` + (went.length ? `: ${went.join('; ')}` : '') + (why.length ? `. Not sent: ${why.join('; ')}` : ''), sent ? undefined : 'error'));
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/third-parties/bulk-lead', requireAuth, handler(async (req, res, actor) => {
    const ids = bulkIds(req);
    if (!ids.length) return res.redirect(withToast(base(actor), 'Tick at least one third party first.', 'error'));
    if (!req.body.lead) return res.redirect(withToast(base(actor), 'Choose the new lead first.', 'error'));
    let changed = 0;
    const why = [];
    for (const id of ids) {
      try {
        const tp = await register.getThirdParty(db, actor, id);
        const open = await openAssessmentOf(actor, tp.id);
        if (!open) { why.push(`${tp.name}: no review open`); continue; }
        const r = await assessments.setLead(db, actor, Number(open.id), req.body.lead);
        if (r.changed) changed += 1;
      } catch (err) {
        if (!(err instanceof TprmError)) throw err;
        if (err.status === 400) return res.redirect(withToast(base(actor), err.message, 'error'));
        why.push(err.status === 404 ? 'one that was not found' : err.message.replace(/\.$/, ''));
      }
    }
    if (changed) await logAction(req.user.id, actor.ws.id, 'tprm_bulk_lead_changed', 'workspace', actor.ws.id, { changed, lead: Number(req.body.lead) }, auditCtx(req));
    return res.redirect(withToast(base(actor), `Lead changed on ${changed} review${changed === 1 ? '' : 's'}` + (why.length ? `. Not changed: ${why.join('; ')}` : '')));
  }, { permission: 'tp.manage' }));

  const clientRequests = require('../lib/tprm/client-requests');
  async function renderRequest(req, res, actor, extra = {}, status = 200) {
    const request = await clientRequests.withAnswerLabels(db, actor.ws, await clientRequests.getForFirm(db, actor, req.params.rid));
    return renderPage(req, res, 'tprm_client_request', actor, { request, labels: request.kind === 'reassessment' ? clientRequests.REASSESS_FIRM_STATUS_LABELS : clientRequests.FIRM_STATUS_LABELS,
      errors: [], duplicates: [], canManage: access.can(actor.user, actor.perms, 'tp.manage'), ...extra }, status);
  }

  app.get('/tprm/clients/:wsId/requests/:rid', requireAuth, handler(async (req, res, actor) => renderRequest(req, res, actor)));

  app.post('/tprm/clients/:wsId/requests/:rid/accept', requireAuth, handler(async (req, res, actor) => {
    try {
      const r = await clientRequests.accept(db, actor, req.params.rid, req.body);
      if (r.needsConfirmation) return renderRequest(req, res, actor, { duplicates: r.duplicates });
      await logAction(req.user.id, actor.ws.id, 'tprm_client_request_accepted', 'tp_client_request', Number(req.params.rid) || 0,
        { third_party_id: r.thirdPartyId, ...(r.assessmentId ? { assessment_id: r.assessmentId, kind: r.kind } : {}) }, auditCtx(req));
      if (r.kind === 'reassessment') {
        return res.redirect(withToast(`${base(actor)}/third-parties/${r.thirdPartyId}/assessments/${r.assessmentId}`, `${r.typeLabel || 'Reassessment'} started from the client's request`));
      }
      return res.redirect(withToast(`${base(actor)}/third-parties/${r.thirdPartyId}`, 'Added from the client\'s request. Start the assessment: the scoping starts from the client\'s answers.'));
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return renderRequest(req, res, actor, { errors: err.errors || [err.message] }, err.status);
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/requests/:rid/decline', requireAuth, handler(async (req, res, actor) => {
    try {
      await clientRequests.decline(db, actor, req.params.rid, req.body);
      await logAction(req.user.id, actor.ws.id, 'tprm_client_request_declined', 'tp_client_request', Number(req.params.rid) || 0, {}, auditCtx(req));
      return res.redirect(withToast(base(actor), 'Request declined. The client sees your reason.'));
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) return renderRequest(req, res, actor, { errors: err.errors || [err.message], declineValue: req.body.reason }, err.status);
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.get('/tprm/clients/:wsId/third-parties/:tpId', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    return renderThirdParty(req, res, actor, thirdParty);
  }));

  const peopleBack = (actor, thirdParty) => `${base(actor)}/third-parties/${thirdParty.id}?tab=people#people`;

  app.post('/tprm/clients/:wsId/third-parties/:tpId/people', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    try {
      const person = await vendorPeople.firmAdd(db, actor, thirdParty.id, req.body);
      return res.redirect(withToast(peopleBack(actor, thirdParty), `${person.name} added${person.role === 'main' ? ' as the main contact' : ''}`));
    } catch (err) {
      if (err instanceof TprmError && (err.status === 400 || err.status === 409)) {
        return renderThirdParty(req, res, actor, thirdParty, { tab: 'people', peoplePanel: { errors: err.errors || [err.message], values: req.body } }, 400);
      }
      throw err;
    }
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/third-parties/:tpId/people/:pid', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    try {
      const person = await vendorPeople.firmUpdate(db, actor, thirdParty.id, req.params.pid, req.body);
      return res.redirect(withToast(peopleBack(actor, thirdParty), `${person.name} updated${person.emailChanged ? '. Links sent to their old address no longer open.' : ''}`));
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderThirdParty(req, res, actor, thirdParty, { tab: 'people', peoplePanel: { editErrors: { [String(req.params.pid)]: { errors: err.errors || [err.message], values: req.body } } } }, 400);
      }
      if (err instanceof TprmError && err.status === 409) return res.redirect(withToast(peopleBack(actor, thirdParty), err.message, 'error'));
      throw err;
    }
  }, { permission: 'tp.manage' }));

  for (const [verb, fn, done] of [['remove', 'firmRemove', p => `${p.name} removed. Links sent to them no longer open, and they can no longer sign in.`], ['main', 'firmMakeMain', p => `${p.name} is now the main contact`]]) {
    app.post(`/tprm/clients/:wsId/third-parties/:tpId/people/:pid/${verb}`, requireAuth, handler(async (req, res, actor) => {
      const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
      try {
        const person = await vendorPeople[fn](db, actor, thirdParty.id, req.params.pid);
        return res.redirect(withToast(peopleBack(actor, thirdParty), done(person)));
      } catch (err) {
        if (err instanceof TprmError && (err.status === 409 || err.status === 404)) return res.redirect(withToast(peopleBack(actor, thirdParty), err.message, 'error'));
        throw err;
      }
    }, { permission: 'tp.manage' }));
  }

  app.get('/tprm/clients/:wsId/third-parties/:tpId/edit', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    return renderThirdPartyForm(req, res, actor, { thirdParty, values: thirdParty });
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/third-parties/:tpId', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    return saveThirdParty(req, res, actor, thirdParty);
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/third-parties/:tpId/services', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    try {
      await register.addService(db, actor, thirdParty.id, req.body);
    } catch (err) {
      if (!(err instanceof TprmError) || err.status !== 400) throw err;
      return renderThirdParty(req, res, actor, thirdParty, { serviceErrors: err.errors || [err.message], serviceValues: req.body }, 400);
    }
    return res.redirect(withToast(`${base(actor)}/third-parties/${thirdParty.id}#services`, 'Service added'));
  }, { permission: 'tp.manage' }));

  async function renderServiceForm(req, res, actor, thirdParty, service, values, errors = [], status = 200) {
    return renderPage(req, res, 'tprm_service_form', actor, { thirdParty, service, values, errors }, status);
  }

  app.get('/tprm/clients/:wsId/third-parties/:tpId/services/:sid/edit', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const service = await register.getService(db, actor, thirdParty.id, req.params.sid);
    return renderServiceForm(req, res, actor, thirdParty, service, service);
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/third-parties/:tpId/services/:sid', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    const service = await register.getService(db, actor, thirdParty.id, req.params.sid);
    try {
      await register.updateService(db, actor, thirdParty.id, service.id, req.body);
    } catch (err) {
      if (!(err instanceof TprmError) || err.status !== 400) throw err;
      return renderServiceForm(req, res, actor, thirdParty, service, req.body, err.errors || [err.message], 400);
    }
    return res.redirect(withToast(`${base(actor)}/third-parties/${thirdParty.id}#services`, 'Service updated'));
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/third-parties/:tpId/services/:sid/remove', requireAuth, handler(async (req, res, actor) => {
    const thirdParty = await register.getThirdParty(db, actor, req.params.tpId);
    await register.removeService(db, actor, thirdParty.id, req.params.sid, req.body);
    return res.redirect(withToast(`${base(actor)}/third-parties/${thirdParty.id}#services`, 'Service removed'));
  }, { permission: 'tp.manage' }));

  async function renderSettings(req, res, actor, { values = null, errors = [], status = 200 } = {}) {
    const settings = await clientSettings.get(db, actor.ws.id);
    const labels = values
      ? (Array.isArray(values.label) ? values.label : [values.label || '']).map((label, i) => ({
        label, tier: (Array.isArray(values.tier) ? values.tier : [values.tier || ''])[i] || '' }))
      : Object.entries(settings.label_tier_map).map(([label, tier]) => ({ label, tier }));
    return renderPage(req, res, 'tprm_settings', actor, {
      settings, labels, errors,
      intervalValues: values || settings,
      rowVersion: values ? values.row_version : settings.row_version,
      defaults: (await clientSettings.intervals(db, actor.ws, settings)).firm,
      thirdPartyCount: await tpSettings.thirdPartyCount(db, actor.ws.id),
      hasIsoProgramme: await tpSettings.hasIsoProgramme(db, actor.ws.id),
    }, status);
  }

  app.get('/tprm/clients/:wsId/settings', requireAuth, handler(async (req, res, actor) =>
    renderSettings(req, res, actor), { permission: 'tp.settings' }));

  app.post('/tprm/clients/:wsId/settings', requireAuth, handler(async (req, res, actor) => {
    let result;
    try {
      result = await clientSettings.update(db, actor, req.body);
    } catch (err) {
      if (err instanceof TprmError && err.status === 400) {
        return renderSettings(req, res, actor, { values: req.body, errors: err.errors || [err.message], status: 400 });
      }
      throw err;
    }
    if (result.changed) {
      await logAction(req.user.id, actor.ws.id, 'tprm_client_settings_updated', 'workspace', actor.ws.id,
        { before: result.before, after: result.after, recalculated: result.recalculated }, auditCtx(req));
    }
    const n = result.recalculated || 0;
    const message = !result.changed ? 'No changes to save'
      : `Settings saved · ${n} third part${n === 1 ? 'y' : 'ies'} not yet assessed ${n === 1 ? 'has' : 'have'} a new tier or due date`;
    return res.redirect(withToast(`${base(actor)}/settings`, message));
  }, { permission: 'tp.settings' }));

  app.get('/tprm/clients/:wsId/import', requireAuth, handler(async (req, res, actor) =>
    renderPage(req, res, 'tprm_import', actor, { mode: 'upload', columns: tpImport.COLUMNS, maxRows: tpImport.MAX_ROWS }),
  { permission: 'tp.manage' }));

  app.get('/tprm/clients/:wsId/import/template', requireAuth, handler(async (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="third_parties_template.csv"');
    return res.send(tpImport.template());
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/import/preview', requireAuth, csvUpload.single('file'), handler(async (req, res, actor) => {
    if (!req.file || !req.file.buffer) {
      return renderPage(req, res, 'tprm_import', actor, {
        mode: 'upload', columns: tpImport.COLUMNS, maxRows: tpImport.MAX_ROWS, uploadError: 'Choose a CSV file to preview.',
      }, 400);
    }
    const filename = req.file.originalname || 'upload.csv';
    const result = await tpImport.preview(db, actor, req.file.buffer, filename);
    return renderPage(req, res, 'tprm_import', actor, {
      mode: 'preview', columns: tpImport.COLUMNS, maxRows: tpImport.MAX_ROWS, filename, ...result,
    }, result.analysis.ok || result.alreadyImported ? 200 : 422);
  }, { permission: 'tp.manage' }));

  app.post('/tprm/clients/:wsId/import/commit', requireAuth, handler(async (req, res, actor) => {
    const csv = req.body.csv_b64 != null ? tpImport.decodeText(req.body.csv_b64) : req.body.csv;
    const result = await tpImport.commit(db, actor, req.body.batch_id, csv);
    if (result.alreadyImported) {
      return res.redirect(withToast(base(actor), 'This file was already imported; nothing more was added', 'warn'));
    }
    await logAction(req.user.id, actor.ws.id, 'tprm_third_parties_imported', 'workspace', actor.ws.id,
      { batch_id: result.batchId, count: result.imported, services: result.services || 0 }, auditCtx(req));
    const withServices = result.services ? `, ${result.services} with a first service` : '';
    return res.redirect(withToast(base(actor), `Imported ${result.imported} third part${result.imported === 1 ? 'y' : 'ies'}${withServices}`));
  }, { permission: 'tp.manage' }));
}

module.exports = { register: registerRoutes };
