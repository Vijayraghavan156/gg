'use strict';

const { withToast, auditCtx } = require('../lib/http-helpers');
const access = require('../lib/tprm/access');
const qt = require('../lib/tprm/q-templates');
const rulesLib = require('../lib/tprm/answer-rules');
const assembly = require('../lib/tprm/questionnaire-assembly');
const { TprmError } = require('../lib/tprm/errors');

const BASE = '/tprm/settings/questionnaires';

function register(app, { db, requireAuth, logAction, xlsxUpload }) {
  const canView = req => access.isFirmUser(req.user) && access.firmCan(req.user, 'tp.view') && !!req.user.firm_id;
  const firmId = req => Number(req.user.firm_id);
  const builderUrl = (id, section) => `${BASE}/${Number(id)}${section ? `?s=${encodeURIComponent(section)}` : ''}`;
  const questionUrl = (id, qid) => `${BASE}/${Number(id)}/questions/${encodeURIComponent(qid)}`;
  const audit = (req, action, id, details = {}) => logAction(req.user.id, null, action, 'tp_q_template', Number(id) || null, details, auditCtx(req));

  const gate = (req, res, edit = false) => {
    if (!canView(req)) { res.status(403).render('error', { user: req.user, message: 'Questionnaires are for consulting-team accounts.' }); return false; }
    if (edit && !qt.canEdit(req.user)) { res.status(403).render('error', { user: req.user, message: 'Only a manager can change your questionnaires.' }); return false; }
    return true;
  };
  const handled = (req, res, err, back) => {
    if (!(err instanceof TprmError)) throw err;
    if (err.status === 404) return res.status(404).render('error', { user: req.user, message: err.message });
    if (err.status === 403) return res.status(403).render('error', { user: req.user, message: err.message });
    return res.redirect(withToast(back, err.message, 'error'));
  };

  app.get(BASE, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res)) return undefined;
      const q = require('../lib/tprm/questionnaires');
      const latest = await q.latestBankVersion(db);
      let bankSummary = null;
      if (latest) {
        const bank = await q.bankContent(db, latest.id);
        const live = (bank.questions || []).filter(x => x.status !== 'Retired');
        bankSummary = { version: latest.version, publishedAt: latest.published_at, questions: live.length,
          modules: assembly.moduleCatalog(bank).length, sections: new Set(live.filter(x => x.set === 'Base').map(x => x.domain)).size };
      }
      return res.render('tprm_q_templates', { user: req.user, active: 'tprm-portfolio', list: await qt.list(db, firmId(req)), bankSummary,
        canEdit: qt.canEdit(req.user), limits: qt.LIMITS });
    } catch (err) { return next(err); }
  });

  app.post(BASE, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res, true)) return undefined;
      try {
        const id = await qt.create(db, req.user, req.body || {});
        await audit(req, 'tprm_q_template_created', id, { name: String((req.body || {}).name || '').slice(0, 80) });
        return res.redirect(withToast(builderUrl(id), 'Questionnaire created. Add its sections and questions, then publish it.'));
      } catch (err) { return handled(req, res, err, BASE); }
    } catch (err) { return next(err); }
  });

  async function loadBuilder(req, id) {
    const t = await qt.get(db, firmId(req), id);
    const sections = t.draft.sections.map(s => ({ ...s, count: t.draft.questions.filter(q => q.section === s.key).length }));
    const chosen = sections.find(s => s.key === String(req.query.s || '')) || sections[0] || null;
    const questions = chosen ? qt.ordered(t.draft).filter(q => q.section === chosen.key) : [];
    return { t, sections, chosen, questions };
  }

  app.get(`${BASE}/:id`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res)) return undefined;
      try {
        const b = await loadBuilder(req, req.params.id);
        return res.render('tprm_q_template', { user: req.user, active: 'tprm-portfolio', ...b, canEdit: qt.canEdit(req.user), problems: qt.problems(b.t.draft),
          typeLabels: rulesLib.ANSWER_TYPE_LABELS, opLabels: assembly.RULE_OP_LABELS, limits: qt.LIMITS });
      } catch (err) { return handled(req, res, err, BASE); }
    } catch (err) { return next(err); }
  });

  app.get(`${BASE}/:id/export.xlsx`, requireAuth, async (req, res, next) => {
    try {
      if (!canView(req)) return res.status(403).end();
      let t;
      try { t = await qt.get(db, firmId(req), req.params.id); } catch (err) { if (err instanceof TprmError && err.status === 404) return res.status(404).end(); throw err; }
      const sheet = require('../lib/tprm/q-template-sheet');
      const label = t.latest && !t.draft_changed ? `version ${t.latest.version}` : 'draft';
      const buffer = await sheet.buildWorkbook(t, qt.ordered(t.draft), `${t.name}, ${label}`);
      const file = `${t.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'questionnaire'}-${label.replace(/\s+/g, '-')}.xlsx`;
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${file}"`);
      res.set('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(buffer);
    } catch (err) { return next(err); }
  });

  app.post(`${BASE}/:id/import`, requireAuth, xlsxUpload.single('sheet'), async (req, res, next) => {
    try {
      if (!gate(req, res, true)) return undefined;
      const back = builderUrl(req.params.id);
      try {
        if (!req.file || !/\.xlsx$/i.test(String(req.file.originalname || ''))) return res.redirect(withToast(back, 'Choose the questionnaire Excel file (.xlsx) to upload.', 'error'));
        const rows = await require('../lib/tprm/q-template-sheet').parseUpload(req.file.buffer);
        const r = await qt.importRows(db, req.user, req.params.id, rows, req.body || {});
        if (r.unchanged) return res.redirect(withToast(back, 'File read: nothing in it differs from the draft.'));
        await audit(req, 'tprm_q_template_imported', req.params.id, { added: r.added, changed: r.changed, removed: r.removed, sections: r.sections });
        const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
        const parts = [r.added && `${n(r.added, 'question')} added`, r.changed && `${n(r.changed, 'question')} changed`, r.removed && `${n(r.removed, 'question')} removed`, r.sections && `${n(r.sections, 'section')} added`].filter(Boolean);
        return res.redirect(withToast(back, `File read: ${parts.join(', ')}. Publish when you are ready.`));
      } catch (err) { return handled(req, res, err, back); }
    } catch (err) { return next(err); }
  });

  const history = require('../lib/tprm/q-template-history');
  const draftContent = t => ({ sections: t.draft.sections, questions: qt.ordered(t.draft) });

  app.get(`${BASE}/:id/publish`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res, true)) return undefined;
      try {
        const t = await qt.get(db, firmId(req), req.params.id);
        const before = t.latest ? (await history.content(db, t.id, t.latest.version)).content : null;
        return res.render('tprm_q_template_changes', { user: req.user, active: 'tprm-portfolio', t, mode: 'publish', d: history.compare(before, draftContent(t)),
          problems: qt.problems(t.draft), fromVersion: t.latest ? t.latest.version : null, toVersion: t.latest ? t.latest.version + 1 : 1, canEdit: true });
      } catch (err) { return handled(req, res, err, builderUrl(req.params.id)); }
    } catch (err) { return next(err); }
  });

  app.get(`${BASE}/:id/versions`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res)) return undefined;
      try {
        const t = await qt.get(db, firmId(req), req.params.id);
        return res.render('tprm_q_template_versions', { user: req.user, active: 'tprm-portfolio', t, list: await history.versions(db, t.id), canEdit: qt.canEdit(req.user) });
      } catch (err) { return handled(req, res, err, builderUrl(req.params.id)); }
    } catch (err) { return next(err); }
  });

  app.get(`${BASE}/:id/versions/:v`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res)) return undefined;
      try {
        const t = await qt.get(db, firmId(req), req.params.id);
        const now = await history.content(db, t.id, req.params.v);
        const prev = now.version > 1 ? (await history.content(db, t.id, now.version - 1)).content : null;
        return res.render('tprm_q_template_changes', { user: req.user, active: 'tprm-portfolio', t, mode: 'version', d: history.compare(prev, now.content),
          problems: [], fromVersion: now.version > 1 ? now.version - 1 : null, toVersion: now.version, version: now, canEdit: qt.canEdit(req.user) });
      } catch (err) { return handled(req, res, err, `${BASE}/${Number(req.params.id)}/versions`); }
    } catch (err) { return next(err); }
  });

  app.post(`${BASE}/:id/versions/:v/restore`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res, true)) return undefined;
      try {
        const r = await qt.restoreVersion(db, req.user, req.params.id, req.params.v, req.body || {});
        await audit(req, 'tprm_q_template_version_restored', req.params.id, { version: r.version });
        return res.redirect(withToast(builderUrl(req.params.id), `The draft now holds version ${r.version}. Publish it to send it again.`));
      } catch (err) { return handled(req, res, err, `${BASE}/${Number(req.params.id)}/versions/${Number(req.params.v) || 0}`); }
    } catch (err) { return next(err); }
  });

  const wantsJson = req => /application\/json/.test(String(req.headers.accept || ''));
  const quick = (path, action, run, message) => app.post(`${BASE}/:id${path}`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res, true)) return undefined;
      const body = req.body || {};
      const back = builderUrl(req.params.id, body.s ? String(body.s) : null);
      try {
        const out = await run(req, body);
        await audit(req, action, req.params.id, { count: out && out.count ? out.count : null });
        const text = typeof message === 'function' ? message(out || {}) : message;
        if (wantsJson(req)) return res.json({ ok: true, message: text, row_version: (await qt.get(db, firmId(req), req.params.id)).row_version });
        return res.redirect(withToast(out && out.section ? builderUrl(req.params.id, out.section) : back, text));
      } catch (err) {
        if (wantsJson(req) && err instanceof TprmError) return res.status(err.status === 404 ? 404 : 400).json({ ok: false, message: err.message });
        return handled(req, res, err, back);
      }
    } catch (err) { return next(err); }
  });
  quick('/questions/order', 'tprm_q_template_questions_reordered', (req, body) => qt.reorderQuestions(db, req.user, req.params.id, body), 'Order saved');
  quick('/sections/order', 'tprm_q_template_sections_reordered', (req, body) => qt.reorderSections(db, req.user, req.params.id, body), 'Order saved');
  quick('/questions/bulk', 'tprm_q_template_questions_bulk', (req, body) => qt.bulkQuestions(db, req.user, req.params.id, body), out => {
    const n = `${out.count} question${out.count === 1 ? '' : 's'}`;
    return { required: `${n} now required`, optional: `${n} now optional`, move: `${n} moved`, remove: `${n} removed` }[out.action] || 'Done';
  });

  const post = (path, action, run, message) => app.post(`${BASE}/:id${path}`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res, true)) return undefined;
      const back = builderUrl(req.params.id, req.body && req.body.s ? String(req.body.s) : req.params.key);
      try {
        const out = await run(req);
        await audit(req, action, req.params.id, { key: req.params.key || req.params.qid || null });
        const to = out && out.redirect ? out.redirect : back;
        return res.redirect(withToast(to, typeof message === 'function' ? message(out) : message));
      } catch (err) { return handled(req, res, err, back); }
    } catch (err) { return next(err); }
  });

  post('/details', 'tprm_q_template_details', req => qt.updateDetails(db, req.user, req.params.id, req.body || {}), 'Name and description saved');
  post('/archive', 'tprm_q_template_archived', req => qt.setStatus(db, req.user, req.params.id, 'archived'), 'Questionnaire archived: it is no longer offered when preparing a questionnaire');
  post('/restore', 'tprm_q_template_restored', req => qt.setStatus(db, req.user, req.params.id, 'active'), 'Questionnaire offered again');
  app.post(`${BASE}/:id/publish`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res, true)) return undefined;
      try {
        const out = await qt.publish(db, req.user, req.params.id, req.body || {});
        await audit(req, 'tprm_q_template_published', req.params.id, { version: out.version });
        return res.redirect(withToast(builderUrl(req.params.id), `Version ${out.version} published. New questionnaires use it; ones already prepared keep theirs.`));
      } catch (err) { return handled(req, res, err, `${BASE}/${Number(req.params.id)}/publish`); }
    } catch (err) { return next(err); }
  });
  post('/discard', 'tprm_q_template_discarded', req => qt.discardDraft(db, req.user, req.params.id, req.body || {}), 'Changes discarded: back to the published version');
  post('/sections', 'tprm_q_template_section_added', async req => {
    const r = await qt.addSection(db, req.user, req.params.id, req.body || {});
    return { redirect: builderUrl(req.params.id, r.key) };
  }, 'Section added');
  post('/sections/:key', 'tprm_q_template_section_renamed', req => qt.renameSection(db, req.user, req.params.id, req.params.key, req.body || {}), 'Section renamed');
  post('/sections/:key/move', 'tprm_q_template_section_moved', req => qt.moveSection(db, req.user, req.params.id, req.params.key, req.body || {}), 'Section moved');
  post('/sections/:key/remove', 'tprm_q_template_section_removed', async req => {
    await qt.removeSection(db, req.user, req.params.id, req.params.key, req.body || {});
    return { redirect: builderUrl(req.params.id) };
  }, 'Section removed');
  post('/questions/:qid/move', 'tprm_q_template_question_moved', async req => {
    await qt.moveQuestion(db, req.user, req.params.id, req.params.qid, req.body || {});
    return null;
  }, 'Question moved');

  async function renderEditor(req, res, { t, qid = null, section = null, values = null, errors = [], status = 200 }) {
    const all = qt.ordered(t.draft);
    const q = qid ? t.draft.questions.find(x => x.id === qid) : null;
    if (qid && !q) throw new TprmError(404, 'This question does not exist.');
    const sectionKey = (values && values.section) || (q ? q.section : section) || (t.draft.sections[0] || {}).key;
    const cut = q ? all.indexOf(q) : (() => {
      const last = all.filter(x => x.section === sectionKey).pop();
      if (last) return all.indexOf(last) + 1;
      const order = t.draft.sections.map(s => s.key);
      const later = all.findIndex(x => order.indexOf(x.section) > order.indexOf(sectionKey));
      return later < 0 ? all.length : later;
    })();
    const earlier = all.slice(0, cut).map(x => ({ id: x.id, theme: x.theme, type: x.answer_type, options: x.options || [] }));
    const publishedIds = await qt.publishedIds(db, t.id);
    return res.status(status).render('tprm_q_template_question', { user: req.user, active: 'tprm-portfolio', t, q, sectionKey, values, errors, earlier, publishedIds,
      types: rulesLib.ANSWER_TYPES, typeLabels: rulesLib.ANSWER_TYPE_LABELS, ops: assembly.RULE_OPS, opLabels: assembly.RULE_OP_LABELS,
      limits: qt.LIMITS, choiceTypes: qt.CHOICE_TYPES, canEdit: qt.canEdit(req.user) });
  }

  app.get(`${BASE}/:id/questions/new`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res, true)) return undefined;
      try {
        const t = await qt.get(db, firmId(req), req.params.id);
        return await renderEditor(req, res, { t, section: String(req.query.section || '') });
      } catch (err) { return handled(req, res, err, builderUrl(req.params.id)); }
    } catch (err) { return next(err); }
  });

  app.get(`${BASE}/:id/questions/:qid`, requireAuth, async (req, res, next) => {
    try {
      if (!gate(req, res)) return undefined;
      try {
        const t = await qt.get(db, firmId(req), req.params.id);
        return await renderEditor(req, res, { t, qid: String(req.params.qid) });
      } catch (err) { return handled(req, res, err, builderUrl(req.params.id)); }
    } catch (err) { return next(err); }
  });

  const saveQuestion = (isNew) => async (req, res, next) => {
    try {
      if (!gate(req, res, true)) return undefined;
      const body = req.body || {};
      let t;
      try {
        t = await qt.get(db, firmId(req), req.params.id);
      } catch (err) { return handled(req, res, err, BASE); }
      try {
        if (isNew) {
          const r = await qt.addQuestion(db, req.user, req.params.id, body);
          await audit(req, 'tprm_q_template_question_added', req.params.id, { question: r.id });
          return res.redirect(withToast(builderUrl(req.params.id, body.section), `${r.id} added`));
        }
        if (body.intent === 'remove') {
          await qt.removeQuestion(db, req.user, req.params.id, req.params.qid, body);
          await audit(req, 'tprm_q_template_question_removed', req.params.id, { question: req.params.qid });
          return res.redirect(withToast(builderUrl(req.params.id, body.section), `${req.params.qid} removed`));
        }
        await qt.saveQuestion(db, req.user, req.params.id, req.params.qid, body);
        await audit(req, 'tprm_q_template_question_saved', req.params.id, { question: req.params.qid });
        return res.redirect(withToast(builderUrl(req.params.id, body.section), `${req.params.qid} saved`));
      } catch (err) {
        if (err instanceof TprmError && [400, 409].includes(err.status)) {
          return await renderEditor(req, res, { t, qid: isNew ? null : String(req.params.qid), section: body.section, values: body, errors: err.errors || [err.message], status: err.status });
        }
        return handled(req, res, err, builderUrl(req.params.id));
      }
    } catch (err) { return next(err); }
  };
  app.post(`${BASE}/:id/questions`, requireAuth, saveQuestion(true));
  app.post(`${BASE}/:id/questions/:qid`, requireAuth, saveQuestion(false));
}

module.exports = { register, BASE };
