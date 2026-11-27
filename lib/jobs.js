const { Client } = require('pg');
const { db, logAction } = require('../db');
const email = require('./email');
const outcomeScope = require('./engagement-outcome-scope');
const engagementDelivery = require('./engagement-delivery');

async function resolveRecipients(workspaceId, userId) {
  if (userId) {
    const u = await db.prepare(`SELECT id, name, email, email_notify FROM users WHERE id=? AND active=1`).get(userId);
    return u ? [u] : [];
  }
  if (!workspaceId) return [];
  const ws = await db.prepare(`SELECT lead_consultant_id, firm_id FROM workspaces WHERE id=?`).get(workspaceId);
  if (!ws) return [];
  if (ws.lead_consultant_id) {
    const lead = await db.prepare(`SELECT id, name, email, email_notify FROM users WHERE id=? AND active=1`).get(ws.lead_consultant_id);
    if (lead) return [lead];
  }
  return await db.prepare(`SELECT id, name, email, email_notify FROM users
    WHERE firm_id=? AND user_type='firm' AND firm_role='manager' AND active=1`).all(ws.firm_id);
}

async function dispatchNotificationEmail({ notificationId, workspaceId, userId, category, title, body, link }) {
  let recipients;
  try { recipients = await resolveRecipients(workspaceId, userId); }
  catch (e) { console.error('[notify->email] resolve failed:', e.message); return; }
  if (!recipients || !recipients.length) return;

  let wsName = null, firmId = null;
  if (workspaceId) {
    const ws = await db.prepare(`SELECT brand_display_name, client_name, firm_id FROM workspaces WHERE id=?`).get(workspaceId);
    if (ws) { wsName = ws.brand_display_name || ws.client_name; firmId = ws.firm_id; }
  }

  for (const r of recipients) {
    const pref = r.email_notify || 'immediate';
    if (pref !== 'immediate') continue;
    if (!r.email) continue;
    const claimed = await db.prepare(`INSERT INTO notification_emails (notification_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(notificationId, r.id);
    if (claimed.changes === 0) continue;
    db.afterCommit(() => email.sendNotificationEmail({
      toEmail: r.email, toName: r.name, title, body, link,
      workspaceName: wsName, firmId, workspaceId, category
    }).catch(err => console.error('[notify->email] send failed:', err && err.message)));
  }
}

async function insertOpenNotification(workspaceId, userId, category, severity, title, body, link, expiresAt) {
  return await db.transaction(async () => {
    await db.lockChain(`notification:${workspaceId}:${userId || ''}:${category}:${title}`);
    const exists = await db.prepare(`SELECT id FROM notifications WHERE workspace_id=? AND user_id IS NOT DISTINCT FROM ? AND category=? AND title=? AND read_at IS NULL AND dismissed_at IS NULL`)
      .get(workspaceId, userId || null, category, title);
    if (exists) return null;
    return (await db.prepare(`INSERT INTO notifications (workspace_id, user_id, category, severity, title, body, link, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, userId || null, category, severity, title, body || null, link || null, expiresAt)).lastInsertRowid;
  })();
}

async function notify(workspaceId, userId, category, severity, title, body, link, expiresInDays) {
  try {
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null;
    const id = await insertOpenNotification(workspaceId, userId, category, severity, title, body, link, expiresAt);
    if (!id) return null;
    const dispatch = () => dispatchNotificationEmail({ notificationId: id, workspaceId, userId: userId || null, category, title, body, link });
    try { await (db.inTransaction ? db.transaction(dispatch)() : dispatch()); }
    catch (e) { console.error('[notify->email] dispatch failed:', e.message); }
    return id;
  } catch (e) { console.error('[notify] failed:', e.message); return null; }
}

function daysBetweenSql(a, b) {
  const isDate = (expr) => expr === 'utc_now_text()' ? 'TRUE' : `${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`;
  return `CASE WHEN ${isDate(a)} AND ${isDate(b)} THEN days_between(${a}, ${b}) END`;
}

async function jobDocumentReviewReminders() {
  const rows = await db.prepare(`SELECT d.id, d.workspace_id, d.name, d.next_review_date,
       ${daysBetweenSql('d.next_review_date', 'utc_now_text()')} AS days_to_review,
       (SELECT id FROM users WHERE id IN (SELECT lead_consultant_id FROM workspaces WHERE id=d.workspace_id)) AS owner_id
       FROM generated_docs d
       WHERE d.status IN ('approved','published') AND d.next_review_date IS NOT NULL`).all();
  let count = 0;
  for (const r of rows) {
    const days = Math.round(r.days_to_review);
    if (days < 0) {
      if (await notify(r.workspace_id, null, 'doc_review_overdue', 'high',
        `Policy review overdue: ${r.name}`,
        `Last reviewed ${Math.abs(days)} days past target. Open a new version or extend the review date.`,
        `/workspaces/${r.workspace_id}/documents/${r.id}`)) count++;
    } else if (days <= 30) {
      if (await notify(r.workspace_id, null, 'doc_review_due', 'medium',
        `Policy review due in ${days} days: ${r.name}`,
        `Plan a review pass before the policy goes stale.`,
        `/workspaces/${r.workspace_id}/documents/${r.id}`, 30)) count++;
    }
  }
  return count;
}

async function jobTaskRecurrence() {
  const rows = await db.prepare(`SELECT * FROM tasks WHERE status='done' AND recurrence IS NOT NULL AND recurrence <> ''
    AND (recurrence_until IS NULL OR recurrence_until >= utc_today_text())`).all();
  let count = 0;
  for (const t of rows) {
    const next = await db.prepare('SELECT 1 FROM tasks WHERE parent_task_id=? AND status NOT IN (\'done\')').get(t.id);
    if (next) continue;
    const intervalDays = { daily: 1, weekly: 7, biweekly: 14, monthly: 30, quarterly: 90, semiannual: 182, annual: 365 }[t.recurrence];
    if (!intervalDays) continue;
    const due = t.due_date ? new Date(new Date(t.due_date).getTime() + intervalDays * 86400000).toISOString().slice(0,10) : null;
    await db.prepare(`INSERT INTO tasks (workspace_id, entity_id, title, description, iso_item_id, assignee_id, due_date, status, created_by, parent_task_id, recurrence, recurrence_until, estimated_minutes, template_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)`).run(
      t.workspace_id, t.entity_id || null, t.title, t.description, t.iso_item_id, t.assignee_id, due, t.created_by, t.id, t.recurrence, t.recurrence_until, t.estimated_minutes, t.template_id);
    count++;
  }
  return count;
}

async function jobOverrideExpiry() {
  const expired = await db.prepare(`SELECT * FROM workspace_role_overrides WHERE expires_at IS NOT NULL AND expires_at < utc_now_text()`).all();
  let count = 0;
  for (const o of expired) {
    await db.prepare('DELETE FROM workspace_role_overrides WHERE id=?').run(o.id);
    await logAction(0, o.workspace_id, 'override_auto_expired', 'user', o.user_id, { permission: o.permission, was_granted: !!o.granted });
    count++;
  }
  return count;
}

async function jobNonconformityReminders() {
  const rows = await db.prepare(`SELECT id, workspace_id, title, severity, responsible, due_date,
      ${daysBetweenSql('due_date', 'utc_now_text()')} AS d
      FROM nonconformities
      WHERE status NOT IN ('closed','verified') AND due_date IS NOT NULL`).all();
  let count = 0;
  for (const r of rows) {
    const days = Math.round(r.d);
    const sev = r.severity ? `${r.severity} NC` : 'NC';
    const owner = r.responsible ? ` Owner: ${r.responsible}.` : '';
    if (days < 0) {
      if (await notify(r.workspace_id, null, 'nc_overdue', 'high',
        `Corrective action overdue: ${r.title}`,
        `Was due ${r.due_date} - ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago. ${sev}.${owner}`,
        `/workspaces/${r.workspace_id}/nonconformities`)) count++;
    } else if (days <= 14) {
      if (await notify(r.workspace_id, null, 'nc_due', 'medium',
        `Corrective action due soon: ${r.title}`,
        `Due ${r.due_date} (in ${days} day${days === 1 ? '' : 's'}). ${sev}.${owner}`,
        `/workspaces/${r.workspace_id}/nonconformities`, 21)) count++;
    }
  }
  return count;
}

async function jobControlReviewReminders() {
  const rows = await db.prepare(`SELECT cs.workspace_id, cs.iso_item_id, i.title FROM v_control_states cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.iso_item_id IN ('annex-a.5.15','annex-a.5.18','annex-a.8.2')
    AND cs.status='Implemented' AND cs.last_updated < utc_text(now() + ('-180 days')::interval)`).all();
  let count = 0;
  for (const r of rows) {
    if (await notify(r.workspace_id, null, 'access_control_stale', 'medium',
      `Access control needs review: ${r.title}`,
      `Last updated > 180 days ago. Re-confirm or update notes.`,
      `/workspaces/${r.workspace_id}/controls/${r.iso_item_id}`, 60)) count++;
  }
  return count;
}

async function jobAccessReviewKickoff() {
  const wsList = (await db.prepare('SELECT id, frameworks FROM workspaces').all())
    .filter(w => require('./iso-lifecycle').hasIsoManagementSystem(require('./frameworks').parseWorkspaceFrameworks(w.frameworks)));
  let count = 0;
  for (const w of wsList) {
    const last = await db.prepare(`SELECT MAX(created_at) AS t FROM access_reviews WHERE workspace_id=?`).get(w.id);
    if (last.t && new Date(last.t) > new Date(Date.now() - 90 * 86400000)) continue;
    if (await notify(w.id, null, 'access_review_due', 'medium',
      'Quarterly access review due',
      'A.5.18 expects periodic review of user access. Open a new access review.',
      `/workspaces/${w.id}/access-reviews`, 14)) count++;
  }
  return count;
}

async function jobEngagementDeliveryAlerts() {
  const insert = async (workspaceId, userId, category, severity, title, body, link) =>
    (await insertOpenNotification(workspaceId, userId, category, severity, title, body, link, null)) ? 1 : 0;
  let count = 0;
  const deliverables = (await db.prepare(`SELECT d.id,d.workspace_id,d.title,d.status,d.due_date,d.owner_id,d.approver_id,
      ph.phase_key,w.frameworks,w.engagement_outcome
    FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    JOIN engagement_delivery_plans p ON p.id=d.plan_id
    JOIN workspaces w ON w.id=d.workspace_id
    WHERE p.status='active' AND d.status NOT IN ('accepted','superseded')`).all())
    .filter(row => outcomeScope.hasIso27001(row) && outcomeScope.isPhaseInContract(row, row.phase_key));
  for (const d of deliverables) {
    const days = d.due_date ? Math.round((Date.parse(`${d.due_date}T12:00:00`) - Date.now()) / 86400000) : null;
    if (days != null && days < 0) count += await insert(d.workspace_id, d.owner_id, 'delivery_overdue', 'high',
      `Delivery overdue: ${d.title}`, `Due ${d.due_date}; ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue.`, `/workspaces/${d.workspace_id}/engagement-plan`);
    else if (days != null && days <= 7) count += await insert(d.workspace_id, d.owner_id, 'delivery_due', 'medium',
      `Delivery due soon: ${d.title}`, `Due ${d.due_date}.`, `/workspaces/${d.workspace_id}/engagement-plan`);
    if (d.status === 'submitted') count += await insert(d.workspace_id, d.approver_id, 'delivery_approval', 'medium',
      `Delivery awaiting approval: ${d.title}`, 'Review the linked evidence against the acceptance criteria.', `/workspaces/${d.workspace_id}/engagement-plan`);
  }
  const waivers = (await db.prepare(`SELECT g.*,p.workspace_id,p.id plan_id,ph.name,ph.phase_key,
      w.frameworks,w.engagement_outcome
    FROM engagement_delivery_gate_decisions g
    JOIN engagement_delivery_phases ph ON ph.id=g.phase_id JOIN engagement_delivery_plans p ON p.id=ph.plan_id
    JOIN workspaces w ON w.id=p.workspace_id
    WHERE g.decision='waived' AND g.waiver_expires_at < utc_today_text()
      AND g.id=(SELECT MAX(g2.id) FROM engagement_delivery_gate_decisions g2 WHERE g2.phase_id=g.phase_id)`).all())
    .filter(row => outcomeScope.hasIso27001(row) && outcomeScope.isPhaseInContract(row, row.phase_key));
  for (const waiver of waivers) {
    await db.transaction(async () => {
      await db.prepare(`INSERT INTO engagement_delivery_gate_decisions (phase_id,decision,criteria_snapshot,snapshot_hash,note,decided_by,evidence_snapshot_json)
        VALUES (?,'reopened',?,?,?, ?,?)`).run(waiver.phase_id, waiver.criteria_snapshot, waiver.snapshot_hash,
          `Waiver automatically expired on ${waiver.waiver_expires_at}.`, waiver.decided_by, waiver.evidence_snapshot_json || null);
      await db.prepare(`UPDATE engagement_delivery_phases SET status='in_progress',actual_end_date=NULL,updated_at=utc_now_text() WHERE id=?`).run(waiver.phase_id);
      await db.prepare(`INSERT INTO engagement_delivery_events (workspace_id,plan_id,entity_type,entity_id,action,from_status,to_status,details,actor_id)
        VALUES (?,?,'phase_gate',?,'waiver_auto_expired','waived','in_progress',?,?)`).run(waiver.workspace_id, waiver.plan_id,
          waiver.phase_id, JSON.stringify({ expires_at: waiver.waiver_expires_at }), waiver.decided_by);
    })();
    const workspace = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(waiver.workspace_id);
    if (workspace) {
      workspace.frameworks = outcomeScope.frameworkCodes(workspace);
      await engagementDelivery.reconcileCompletionState(db, workspace, waiver.decided_by, {
        action: 'reopened_after_waiver_expiry',
        reason: 'A delivery phase-gate waiver expired and the required gate is open again.',
        details: { phase_id: waiver.phase_id, waiver_expires_at: waiver.waiver_expires_at }
      });
    }
    await logAction(waiver.decided_by, waiver.workspace_id, 'expire_delivery_gate_waiver', 'engagement_phase', waiver.phase_id, { expires_at: waiver.waiver_expires_at });
    count += await insert(waiver.workspace_id, null, 'delivery_waiver_expired', 'high',
      `Phase-gate waiver expired: ${waiver.name}`, `Expired ${waiver.waiver_expires_at}; the gate is open again.`, `/workspaces/${waiver.workspace_id}/engagement-plan?view=gates`);
  }
  return count;
}

async function jobRestoreDrill(restore = require('./restore-check'), now = () => Date.now()) {
  if (process.env.ISMS_RESTORE_DRILL_DISABLED === '1') return 'disabled (ISMS_RESTORE_DRILL_DISABLED=1)';
  const last = await restore.lastDrill();
  const rawRanAt = last && String(last.ran_at || '');
  const normalizedRanAt = rawRanAt && !/[zZ]|[+-]\d\d:\d\d$/.test(rawRanAt)
    ? `${rawRanAt.replace(' ', 'T')}Z`
    : rawRanAt;
  const lastRanAt = Date.parse(normalizedRanAt);
  let fullGenerationVerified = false;
  try { fullGenerationVerified = JSON.parse(last && last.error || '{}').fullGenerationVerified === true; }
  catch (_) { }
  if (last && last.status === 'ok' && fullGenerationVerified && Number.isFinite(lastRanAt) &&
      (now() - lastRanAt) < 30 * 86400000) return 'not due';
  const r = await restore.runDrill();
  return r.ok ? `passed (${r.ms}ms)` : `FAILED: ${r.error}`;
}

async function jobSessionSweep() {
  try {
    const r = await db.prepare('DELETE FROM sessions WHERE expire <= utc_now_text()').run();
    return `${r.changes} expired session(s) cleared`;
  } catch (e) { return 'skipped: ' + e.message; }
}

async function jobLoginFailureSweep() {
  const r = await db.prepare('DELETE FROM login_failures WHERE window_ends_at < now()').run();
  return `${r.changes} ended login-failure window(s) cleared`;
}

const JOBS = [
  ['sessionSweep',            jobSessionSweep],
  ['loginFailureSweep',       jobLoginFailureSweep],
  ['restoreDrill',            jobRestoreDrill],
  ['documentReviewReminders', jobDocumentReviewReminders],
  ['taskRecurrence',           jobTaskRecurrence],
  ['overrideExpiry',           jobOverrideExpiry],
  ['nonconformityReminders',   jobNonconformityReminders],
  ['controlReviewReminders',   jobControlReviewReminders],
  ['accessReviewKickoff',      jobAccessReviewKickoff],
  ['engagementDeliveryAlerts', jobEngagementDeliveryAlerts]
];

function registerJob(name, fn) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(name) || typeof fn !== 'function') {
    throw new TypeError('registerJob needs a name and a function.');
  }
  if (JOBS.some(([existing]) => existing === name)) return;
  JOBS.push([name, fn]);
}

const JOB_LOCK_PREFIX = 'isms:job:';

async function openJobLockSession() {
  const client = new Client({
    connectionString: db.pool.options.connectionString,
    application_name: 'iso27001-tool:jobs',
  });
  client.on('error', (error) => console.error('[jobs] lock connection error:', error.message));
  await client.connect();
  return client;
}

async function runAllJobs() {
  const out = {};
  const session = await openJobLockSession();
  try {
    for (const [name, fn] of JOBS) {
      const key = JOB_LOCK_PREFIX + name;
      let held = false;
      try {
        held = (await session.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [key])).rows[0].held;
        if (!held) { out[name] = 'skipped: running on another instance'; continue; }
        out[name] = await fn();
      } catch (e) {
        out[name] = 'error: ' + e.message;
        console.error(`[jobs.${name}]`, e);
      } finally {
        if (held) await session.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
      }
    }
  } finally {
    await session.end().catch(() => {});
  }
  return out;
}

function runScheduledJobs() {
  runAllJobs().catch((error) => console.error('[jobs] scheduled run failed:', error.message));
}

let timer = null;
let startupTimer = null;

function stop() {
  if (startupTimer) clearTimeout(startupTimer);
  if (timer) clearInterval(timer);
  startupTimer = null;
  timer = null;
}

function start(intervalMinutes = 60) {
  stop();
  const parsedMinutes = Number(intervalMinutes);
  const intervalMs = (Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes : 60) * 60 * 1000;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runScheduledJobs();
  }, 5000);
  startupTimer.unref();
  timer = setInterval(runScheduledJobs, intervalMs);
  timer.unref();
}

function status() {
  return { startupScheduled: !!startupTimer, intervalScheduled: !!timer };
}

module.exports = {
  runAllJobs,
  registerJob,
  jobNames: () => JOBS.map(([name]) => name),
  start,
  stop,
  status,
  notify,
  jobLoginFailureSweep,
  jobRestoreDrill,
  jobEngagementDeliveryAlerts,
  jobAccessReviewKickoff,
};
