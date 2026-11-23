'use strict';

const fts = require('../lib/fts');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction } = deps;

  const INCIDENT_CATEGORIES = Object.freeze([
    ['malware', 'Malware'], ['phishing', 'Phishing / social engineering'], ['breach', 'Data breach / unauthorized access'],
    ['dos', 'Denial of service'], ['physical', 'Physical security'], ['insider', 'Insider threat'], ['supplier', 'Supplier-originated'],
  ]);
  const CHANGE_CATEGORIES = Object.freeze([
    ['infrastructure', 'Infrastructure'], ['application', 'Application'], ['network', 'Network'],
    ['security', 'Security'], ['policy', 'Policy / procedure'],
  ]);
  const CATEGORY_LABELS = Object.fromEntries([...INCIDENT_CATEGORIES, ...CHANGE_CATEGORIES, ['other', 'Other']]);
  const categoryLabel = (category) => CATEGORY_LABELS[category] || String(category || '').replace(/_/g, ' ');

  app.get('/workspaces/:wsId/incidents', requireAuth, requireWorkspace, async (req, res) => {
    const filter = req.query.filter || 'open';
    let q = `SELECT * FROM incidents WHERE workspace_id = ?`;
    if (filter === 'open') q += ` AND status NOT IN ('closed')`;
    const pgInc = await paginate(db, req, {
      count: q.replace('SELECT *', 'SELECT COUNT(*) c'),
      rows: q + ` ORDER BY detected_at DESC NULLS LAST, created_at DESC`,
      params: [req.workspace.id], perPage: 100,
    });
    res.render('incidents', { user: req.user, ws: req.workspace, incidents: pgInc.rows, filter,
      pg: pgInc, pagerHref: p => pageHref(req, p), categories: INCIDENT_CATEGORIES, categoryLabel });
  });

  app.post('/workspaces/:wsId/incidents', requireAuth, requireWorkspace, requirePermission('incident.manage'), async (req, res) => {
    const { title, category, severity, detected_at, reported_by, description } = req.body;
    if (!title) return redirectBack(req, res);
    const id = (await db.prepare(`INSERT INTO incidents (workspace_id, title, category, severity, detected_at, reported_by, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.workspace.id, title, category || 'other', severity || 'medium',
      detected_at || null, reported_by || null, description || null)).lastInsertRowid;
    await fts.refresh(req.workspace.id, 'incident', id);
    await logAction(req.user.id, req.workspace.id, 'create_incident', 'incident', id, { title });
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/incidents/' + id, 'Incident logged'));
  });

  app.get('/workspaces/:wsId/incidents/:id', requireAuth, requireWorkspace, async (req, res) => {
    const inc = await db.prepare(`SELECT * FROM incidents WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!inc) return res.status(404).send('Not found');
    const events = await db.prepare('SELECT * FROM incident_events WHERE incident_id=? ORDER BY event_at').all(inc.id);
    const runbooks = await db.prepare(`SELECT id, name, category, trigger_severity FROM runbooks WHERE is_system=1 OR firm_id=? ORDER BY name`).all(req.workspace.firm_id);
    let runbook = null;
    if (inc.runbook_id) {
      runbook = await db.prepare('SELECT * FROM runbooks WHERE id=?').get(inc.runbook_id);
      if (runbook) runbook.steps = JSON.parse(runbook.steps);
    }
    res.render('incident_detail', { user: req.user, ws: req.workspace, inc, events, runbooks, runbook,
      categories: INCIDENT_CATEGORIES });
  });

  app.post('/workspaces/:wsId/incidents/:id', requireAuth, requireWorkspace, requirePermission('incident.manage'), async (req, res) => {
    const f = ['title','category','severity','detected_at','reported_by','status','description','affected_assets',
              'containment_actions','eradication_actions','recovery_actions','lessons_learned','external_notification'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (req.body.status === 'closed') set.push('closed_at=utc_now_text()');
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      await db.prepare(`UPDATE incidents SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      await fts.refresh(req.workspace.id, 'incident', req.params.id);
      await logAction(req.user.id, req.workspace.id, 'update_incident', 'incident', req.params.id, null);
    }
    res.redirect('/workspaces/' + req.workspace.id + '/incidents/' + req.params.id);
  });

  app.post('/workspaces/:wsId/incidents/:id/promote-nc', requireAuth, requireWorkspace, requirePermission('incident.manage'), async (req, res) => {
    const inc = await db.prepare(`SELECT * FROM incidents WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!inc) return redirectBack(req, res);
    if (inc.nonconformity_id) return res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + inc.nonconformity_id);
    const sev = inc.severity === 'critical' || inc.severity === 'high' ? 'major' : 'minor';
    const ncId = (await db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, source_ref, description, severity)
      VALUES (?, ?, 'incident', ?, ?, ?)`).run(req.workspace.id, inc.title, 'Incident #' + inc.id, inc.description, sev)).lastInsertRowid;
    await db.prepare(`UPDATE incidents SET nonconformity_id=? WHERE id=? AND workspace_id=?`).run(ncId, inc.id, req.workspace.id);
    await fts.refresh(req.workspace.id, 'nc', ncId);
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + ncId);
  });

  app.post('/workspaces/:wsId/incidents/:id/delete', requireAuth, requireWorkspace, requirePermission('incident.manage'), async (req, res) => {
    await db.prepare(`DELETE FROM incidents WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    await fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'incident', entityId: req.params.id });
    res.redirect('/workspaces/' + req.workspace.id + '/incidents');
  });

  app.get('/workspaces/:wsId/bcp', requireAuth, requireWorkspace, async (req, res) => {
    const wsId = req.workspace.id;
    const processes = await db.prepare(`SELECT * FROM bcp_processes WHERE workspace_id=? ORDER BY
      CASE criticality WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, name`).all(wsId);
    const plans = await db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM bcp_plan_processes pp WHERE pp.plan_id=p.id) AS linked_count,
      (SELECT MAX(t.test_date) FROM bcp_tests t WHERE t.plan_id=p.id) AS last_tested,
      (SELECT COUNT(*) FROM bcp_tests t WHERE t.plan_id=p.id AND t.pass=1) AS tests_pass,
      (SELECT COUNT(*) FROM bcp_tests t WHERE t.plan_id=p.id AND (t.pass=0 OR t.pass IS NULL)) AS tests_fail
      FROM bcp_plans p WHERE p.workspace_id=? ORDER BY p.name`).all(wsId);
    const totalProcesses = processes.length;
    const criticalProcesses = processes.filter(p => p.criticality === 'critical').length;
    const linkedProcessIds = new Set((await db.prepare(`SELECT DISTINCT process_id FROM bcp_plan_processes pp
      JOIN bcp_plans pl ON pl.id=pp.plan_id WHERE pl.workspace_id=?`).all(wsId)).map(r => r.process_id));
    const criticalUnlinked = processes.filter(p => p.criticality === 'critical' && !linkedProcessIds.has(p.id));
    const today = new Date().toISOString().split('T')[0];
    const overdueReview = plans.filter(p => p.next_review_date && p.next_review_date < today).length;
    const lastTestRow = await db.prepare(`SELECT MAX(test_date) AS d FROM bcp_tests WHERE workspace_id=?`).get(wsId);
    const lastTestDate = lastTestRow ? lastTestRow.d : null;
    const summary = { totalProcesses, criticalProcesses, criticalUnlinked: criticalUnlinked.length, overdueReview, lastTestDate };
    res.render('bcp', { user: req.user, ws: req.workspace, processes, plans, summary, criticalUnlinked, today });
  });

  app.post('/workspaces/:wsId/bcp/processes', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { name, description, owner_name, criticality, max_tolerable_downtime_hours, rto_hours, rpo_hours, dependencies, peak_periods, status } = req.body;
    if (!name) return redirectBack(req, res);
    const id = (await db.prepare(`INSERT INTO bcp_processes (workspace_id, name, description, owner_name, criticality,
      max_tolerable_downtime_hours, rto_hours, rpo_hours, dependencies, peak_periods, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, name, description || null, owner_name || null, criticality || 'medium',
      max_tolerable_downtime_hours || null, rto_hours || null, rpo_hours || null,
      dependencies || null, peak_periods || null, status || 'active'
    )).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_bcp_process', 'bcp_process', id, { name }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp', 'Process added'));
  });

  app.post('/workspaces/:wsId/bcp/processes/:id', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const f = ['name','description','owner_name','criticality','max_tolerable_downtime_hours','rto_hours','rpo_hours','dependencies','peak_periods','status'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      await db.prepare(`UPDATE bcp_processes SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      await logAction(req.user.id, req.workspace.id, 'update_bcp_process', 'bcp_process', req.params.id, null, auditCtx(req));
    }
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/bcp/processes/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare(`DELETE FROM bcp_processes WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'delete_bcp_process', 'bcp_process', req.params.id, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp', 'Process deleted'));
  });

  app.post('/workspaces/:wsId/bcp/plans', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { name, description, plan_type, recovery_steps, key_contacts, alternate_site, status, next_review_date } = req.body;
    if (!name) return redirectBack(req, res);
    const id = (await db.prepare(`INSERT INTO bcp_plans (workspace_id, name, description, plan_type, recovery_steps,
      key_contacts, alternate_site, status, next_review_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, name, description || null, plan_type || 'bcp', recovery_steps || null,
      key_contacts || null, alternate_site || null, status || 'draft', next_review_date || null, req.user.id
    )).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_bcp_plan', 'bcp_plan', id, { name }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp/plans/' + id, 'Plan created'));
  });

  app.get('/workspaces/:wsId/bcp/plans/:id', requireAuth, requireWorkspace, async (req, res) => {
    const plan = await db.prepare(`SELECT * FROM bcp_plans WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!plan) return res.status(404).send('Not found');
    const linkedProcesses = await db.prepare(`SELECT p.*, pp.id AS link_id FROM bcp_processes p
      JOIN bcp_plan_processes pp ON pp.process_id=p.id WHERE pp.plan_id=? AND p.workspace_id=?`).all(plan.id, req.workspace.id);
    const tests = await db.prepare(`SELECT * FROM bcp_tests WHERE plan_id=? AND workspace_id=? ORDER BY test_date DESC NULLS LAST`).all(plan.id, req.workspace.id);
    const allProcesses = await db.prepare(`SELECT * FROM bcp_processes WHERE workspace_id=? ORDER BY name`).all(req.workspace.id);
    const linkedIds = new Set(linkedProcesses.map(p => p.id));
    const unlinkableProcesses = allProcesses.filter(p => !linkedIds.has(p.id));
    res.render('bcp_plan', { user: req.user, ws: req.workspace, plan, linkedProcesses, tests, allProcesses, unlinkableProcesses });
  });

  app.post('/workspaces/:wsId/bcp/plans/:id', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const f = ['name','description','plan_type','recovery_steps','key_contacts','alternate_site','status','next_review_date'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (req.body.mark_reviewed) {
      set.push('last_reviewed_at=utc_now_text()');
    }
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      await db.prepare(`UPDATE bcp_plans SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      await logAction(req.user.id, req.workspace.id, 'update_bcp_plan', 'bcp_plan', req.params.id, null, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/bcp/plans/' + req.params.id);
  });

  app.post('/workspaces/:wsId/bcp/plans/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare(`DELETE FROM bcp_plans WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'delete_bcp_plan', 'bcp_plan', req.params.id, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp', 'Plan deleted'));
  });

  app.post('/workspaces/:wsId/bcp/plans/:id/processes', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const planId = req.params.id;
    const plan = await db.prepare(`SELECT id FROM bcp_plans WHERE id=? AND workspace_id=?`).get(planId, req.workspace.id);
    if (!plan) return res.status(404).send('Not found');
    if (req.body.action === 'link' && req.body.process_id) {
      const proc = await db.prepare(`SELECT id FROM bcp_processes WHERE id=? AND workspace_id=?`).get(req.body.process_id, req.workspace.id);
      if (proc) {
        await db.prepare(`INSERT INTO bcp_plan_processes (plan_id, process_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(planId, proc.id);
        await logAction(req.user.id, req.workspace.id, 'link_bcp_process', 'bcp_plan', planId, { process_id: proc.id }, auditCtx(req));
      }
    } else if (req.body.action === 'unlink' && req.body.process_id) {
      await db.prepare(`DELETE FROM bcp_plan_processes WHERE plan_id=? AND process_id=?`).run(planId, req.body.process_id);
      await logAction(req.user.id, req.workspace.id, 'unlink_bcp_process', 'bcp_plan', planId, { process_id: req.body.process_id }, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/bcp/plans/' + planId);
  });

  app.post('/workspaces/:wsId/bcp/plans/:id/tests', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const planId = req.params.id;
    const plan = await db.prepare(`SELECT id FROM bcp_plans WHERE id=? AND workspace_id=?`).get(planId, req.workspace.id);
    if (!plan) return res.status(404).send('Not found');
    const { test_type, test_date, participants, scenario_description, results, lessons_learned,
      rto_achieved_hours, rpo_achieved_hours, pass, action_items, next_test_date } = req.body;
    const id = (await db.prepare(`INSERT INTO bcp_tests (workspace_id, plan_id, test_type, test_date, participants,
      scenario_description, results, lessons_learned, rto_achieved_hours, rpo_achieved_hours, pass,
      action_items, next_test_date, conducted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, planId, test_type || 'tabletop', test_date || null, participants || null,
      scenario_description || null, results || null, lessons_learned || null,
      rto_achieved_hours || null, rpo_achieved_hours || null,
      pass === '1' ? 1 : (pass === '0' ? 0 : null),
      action_items || null, next_test_date || null, req.user.id
    )).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_bcp_test', 'bcp_test', id, { plan_id: planId, test_type }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp/plans/' + planId, 'Test recorded'));
  });

  app.post('/workspaces/:wsId/bcp/tests/:testId', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const test = await db.prepare(`SELECT * FROM bcp_tests WHERE id=? AND workspace_id=?`).get(req.params.testId, req.workspace.id);
    if (!test) return res.status(404).send('Not found');
    const f = ['test_type','test_date','participants','scenario_description','results','lessons_learned',
      'rto_achieved_hours','rpo_achieved_hours','action_items','next_test_date'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (req.body.pass !== undefined) { set.push('pass=?'); vals.push(req.body.pass === '1' ? 1 : (req.body.pass === '0' ? 0 : null)); }
    if (set.length) {
      vals.push(req.params.testId, req.workspace.id);
      await db.prepare(`UPDATE bcp_tests SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      await logAction(req.user.id, req.workspace.id, 'update_bcp_test', 'bcp_test', req.params.testId, null, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/bcp/plans/' + test.plan_id);
  });

  app.post('/workspaces/:wsId/bcp/tests/:testId/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const test = await db.prepare(`SELECT plan_id FROM bcp_tests WHERE id=? AND workspace_id=?`).get(req.params.testId, req.workspace.id);
    if (!test) return res.status(404).send('Not found');
    await db.prepare(`DELETE FROM bcp_tests WHERE id=? AND workspace_id=?`).run(req.params.testId, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'delete_bcp_test', 'bcp_test', req.params.testId, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp/plans/' + test.plan_id, 'Test deleted'));
  });

  app.get('/workspaces/:wsId/changes', requireAuth, requireWorkspace, async (req, res) => {
    const { status, change_type, risk_level } = req.query;
    let q = `SELECT * FROM changes WHERE workspace_id=?`;
    const params = [req.workspace.id];
    if (status && status !== 'all') { q += ` AND status=?`; params.push(status); }
    if (change_type && change_type !== 'all') { q += ` AND change_type=?`; params.push(change_type); }
    if (risk_level && risk_level !== 'all') { q += ` AND risk_level=?`; params.push(risk_level); }
    const pgCh = await paginate(db, req, {
      count: q.replace('SELECT *', 'SELECT COUNT(*) c'),
      rows: q + ` ORDER BY created_at DESC`,
      params, perPage: 100,
    });
    const changes = pgCh.rows;

    const total = (await db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=?`).get(req.workspace.id)).c;
    const openCount = (await db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status NOT IN ('closed')`).get(req.workspace.id)).c;
    const emergencyCount = (await db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND change_type='emergency'`).get(req.workspace.id)).c;
    const pendingApproval = (await db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status='submitted'`).get(req.workspace.id)).c;
    const implemented = (await db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status IN ('implemented','closed')`).get(req.workspace.id)).c;
    const closed = (await db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status='closed'`).get(req.workspace.id)).c;
    const pirPct = implemented > 0 ? Math.round((closed / implemented) * 100) : 0;

    res.render('changes', {
      user: req.user, ws: req.workspace, changes,
      filters: { status: status || 'all', change_type: change_type || 'all', risk_level: risk_level || 'all' },
      stats: { total, openCount, emergencyCount, pendingApproval, pirPct },
      pg: pgCh, pagerHref: p => pageHref(req, p), categories: CHANGE_CATEGORIES
    });
  });

  app.get('/workspaces/:wsId/changes/:id', requireAuth, requireWorkspace, async (req, res) => {
    const change = await db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return res.status(404).render('error', { user: req.user, message: 'Change request not found.' });
    const approvals = await db.prepare(`SELECT * FROM change_approvals WHERE change_id=? AND workspace_id=? ORDER BY sequence, id`).all(change.id, req.workspace.id);
    res.render('change_detail', { user: req.user, ws: req.workspace, change, approvals, categories: CHANGE_CATEGORIES, categoryLabel });
  });

  app.post('/workspaces/:wsId/changes', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const { title, description, change_type, category, risk_assessment, risk_level, impact_assessment, rollback_plan, requester_name } = req.body;
    if (!title || !title.trim()) return redirectBack(req, res);
    const id = (await db.prepare(`INSERT INTO changes (workspace_id, title, description, change_type, category, requester_name, requester_id, risk_assessment, risk_level, impact_assessment, rollback_plan, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, title.trim(), description || null, change_type || 'normal', category || null,
      requester_name || req.user.name || req.user.email, req.user.id,
      risk_assessment || null, risk_level || 'medium', impact_assessment || null, rollback_plan || null,
      req.user.id
    )).lastInsertRowid;
    await logAction(req.user.id, req.workspace.id, 'create_change', 'change', id, { title: title.trim() }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + id, 'Change request created'));
  });

  app.post('/workspaces/:wsId/changes/:id', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const change = await db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res);
    const { title, description, change_type, category, risk_assessment, risk_level, impact_assessment, rollback_plan, requester_name, implementation_notes, test_results } = req.body;
    await db.prepare(`UPDATE changes SET title=?, description=?, change_type=?, category=?, risk_assessment=?, risk_level=?, impact_assessment=?, rollback_plan=?, requester_name=?, implementation_notes=?, test_results=?
      WHERE id=? AND workspace_id=?`).run(
      title || change.title, description || null, change_type || change.change_type, category || null,
      risk_assessment || null, risk_level || change.risk_level, impact_assessment || null, rollback_plan || null,
      requester_name || change.requester_name, implementation_notes || null, test_results || null,
      req.params.id, req.workspace.id
    );
    await logAction(req.user.id, req.workspace.id, 'update_change', 'change', req.params.id, null, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/changes/' + req.params.id);
  });

  app.post('/workspaces/:wsId/changes/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    await db.prepare(`DELETE FROM change_approvals WHERE change_id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    await db.prepare(`DELETE FROM changes WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'delete_change', 'change', req.params.id, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes', 'Change request deleted'));
  });

  app.post('/workspaces/:wsId/changes/:id/submit', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const change = await db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=? AND status='draft'`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res, 'Change must be in draft status to submit', 'warn');
    await db.prepare(`UPDATE changes SET status='submitted', submitted_at=utc_now_text() WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'submit_change', 'change', req.params.id, { from: 'draft', to: 'submitted' }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + req.params.id, 'Change submitted for approval'));
  });

  app.post('/workspaces/:wsId/changes/:id/approve', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const change = await db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res);
    if (change.status !== 'submitted' && !(change.change_type === 'emergency' && change.status === 'implemented')) {
      return redirectBack(req, res, 'Change is not awaiting approval', 'warn');
    }
    const reason = req.body.reason || null;
    await db.prepare(`INSERT INTO change_approvals (change_id, workspace_id, approver_id, approver_name, decision, reason, decided_at)
      VALUES (?, ?, ?, ?, 'approved', ?, utc_now_text())`).run(
      change.id, req.workspace.id, req.user.id, req.user.name || req.user.email, reason
    );
    if (change.status === 'submitted') {
      await db.prepare(`UPDATE changes SET status='approved', approved_at=utc_now_text() WHERE id=? AND workspace_id=?`).run(change.id, req.workspace.id);
    }
    await logAction(req.user.id, req.workspace.id, 'approve_change', 'change', change.id, { decision: 'approved', reason }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change approved'));
  });

  app.post('/workspaces/:wsId/changes/:id/reject', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const change = await db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=? AND status='submitted'`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res, 'Change is not awaiting approval', 'warn');
    const reason = req.body.reason || null;
    await db.prepare(`INSERT INTO change_approvals (change_id, workspace_id, approver_id, approver_name, decision, reason, decided_at)
      VALUES (?, ?, ?, ?, 'rejected', ?, utc_now_text())`).run(
      change.id, req.workspace.id, req.user.id, req.user.name || req.user.email, reason
    );
    await db.prepare(`UPDATE changes SET status='rejected' WHERE id=? AND workspace_id=?`).run(change.id, req.workspace.id);
    await logAction(req.user.id, req.workspace.id, 'reject_change', 'change', change.id, { decision: 'rejected', reason }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change rejected'));
  });

  app.post('/workspaces/:wsId/changes/:id/implement', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const change = await db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res);
    const allowedStatuses = change.change_type === 'emergency' ? ['draft', 'approved'] : ['approved'];
    if (!allowedStatuses.includes(change.status)) {
      return redirectBack(req, res, 'Change must be approved before implementation' + (change.change_type === 'emergency' ? ' (or draft for emergency)' : ''), 'warn');
    }
    const { implementation_notes, test_results } = req.body;
    await db.prepare(`UPDATE changes SET status='implemented', implemented_at=utc_now_text(), implementation_notes=?, test_results=?
      WHERE id=? AND workspace_id=?`).run(
      implementation_notes || change.implementation_notes || null,
      test_results || change.test_results || null,
      change.id, req.workspace.id
    );
    await logAction(req.user.id, req.workspace.id, 'implement_change', 'change', change.id, { from: change.status, to: 'implemented' }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change marked as implemented'));
  });

  app.post('/workspaces/:wsId/changes/:id/close', requireAuth, requireWorkspace, requirePermission('control.update'), async (req, res) => {
    const change = await db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res);
    if (change.status !== 'implemented') return redirectBack(req, res, 'Change must be implemented before closing', 'warn');
    if (change.change_type === 'emergency') {
      const hasApproval = (await db.prepare(`SELECT COUNT(*) c FROM change_approvals WHERE change_id=? AND workspace_id=? AND decision='approved'`).get(change.id, req.workspace.id)).c;
      if (!hasApproval) return redirectBack(req, res, 'Emergency changes require retrospective approval before closing', 'warn');
    }
    const { post_implementation_review, success, pir_date } = req.body;
    await db.prepare(`UPDATE changes SET status='closed', closed_at=utc_now_text(), post_implementation_review=?, success=?, pir_date=?
      WHERE id=? AND workspace_id=?`).run(
      post_implementation_review || null,
      success === 'yes' || success === '1' ? 1 : 0,
      pir_date || new Date().toISOString().split('T')[0],
      change.id, req.workspace.id
    );
    await logAction(req.user.id, req.workspace.id, 'close_change', 'change', change.id, { success: success === 'yes' || success === '1' ? 1 : 0 }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change closed with PIR'));
  });
}

module.exports = { register };
