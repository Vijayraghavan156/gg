const { db } = require('../db');
const enc = require('./encryption');
const ctlReads = require('./control-reads');

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function buildContext(wsId) {
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();

  const cs = ctlReads.tables(db, wsId).cs;
  const totals = await db.prepare(`SELECT
    SUM(CASE WHEN status='Implemented' THEN 1 ELSE 0 END) implemented,
    SUM(CASE WHEN status='Partially Implemented' THEN 1 ELSE 0 END) partial,
    SUM(CASE WHEN status='Not Implemented' THEN 1 ELSE 0 END) not_impl,
    COUNT(*) total
    FROM ${cs} WHERE workspace_id=?`).get(wsId);
  const totalItems = (await db.prepare(`SELECT COUNT(*) c FROM iso_items`).get()).c;

  const soa = {
    included: (await db.prepare(`SELECT COUNT(*) c FROM ${cs} cs INNER JOIN iso_items i ON i.id=cs.iso_item_id WHERE cs.workspace_id=? AND cs.applicability='included' AND i.type='control'`).get(wsId)).c,
    excluded: (await db.prepare(`SELECT COUNT(*) c FROM ${cs} cs INNER JOIN iso_items i ON i.id=cs.iso_item_id WHERE cs.workspace_id=? AND cs.applicability='excluded' AND i.type='control'`).get(wsId)).c,
    undecided: (await db.prepare(`SELECT COUNT(*) c FROM iso_items i LEFT JOIN ${cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=? WHERE i.type='control' AND COALESCE(cs.applicability,'undecided')='undecided'`).get(wsId)).c
  };
  const ncs = await db.prepare(`SELECT severity, status, COUNT(*) c FROM nonconformities WHERE workspace_id=? GROUP BY severity, status`).all(wsId);
  const findings = {
    major: ncs.filter(n => n.severity === 'major').reduce((s, n) => s + n.c, 0),
    minor: ncs.filter(n => n.severity === 'minor').reduce((s, n) => s + n.c, 0),
    observations: 0,
    open: ncs.filter(n => !['closed','verified'].includes(n.status)).reduce((s, n) => s + n.c, 0),
    closed: ncs.filter(n => ['closed','verified'].includes(n.status)).reduce((s, n) => s + n.c, 0)
  };
  findings.observations = (await db.prepare(`SELECT COUNT(*) c FROM audit_observations o INNER JOIN audits a ON a.id=o.audit_id WHERE a.workspace_id=?`).get(wsId)).c;

  const last_mrm = await db.prepare(`SELECT meeting_date FROM mrms WHERE workspace_id=? AND status='complete' ORDER BY meeting_date DESC NULLS LAST LIMIT 1`).get(wsId);
  const last_audit = await db.prepare(`SELECT audit_date FROM audits WHERE workspace_id=? AND status='complete' ORDER BY audit_date DESC NULLS LAST LIMIT 1`).get(wsId);

  const recordsRows = await db.prepare(`SELECT name, status FROM (
    SELECT 'ISMS scope' AS name, CASE WHEN length(coalesce(scope,''))>10 THEN 'present' ELSE 'missing' END AS status FROM workspaces WHERE id=?
  )`).all(wsId);
  const records_table = '| Record | Status |\n|--------|--------|\n' + recordsRows.map(r => `| ${esc(r.name)} | ${r.status} |`).join('\n');

  const top_risks = await db.prepare(`SELECT id, title, likelihood, impact, treatment, owner_name FROM risks WHERE workspace_id=? ORDER BY (likelihood*impact) DESC NULLS LAST LIMIT 10`).all(wsId);
  const top_risks_table = '| ID | Title | L×I | Score | Treatment | Owner |\n|----|-------|-----|-------|-----------|-------|\n'
    + top_risks.map(r => `| R-${String(r.id).padStart(3,'0')} | ${esc(r.title)} | ${r.likelihood}×${r.impact} | ${r.likelihood*r.impact} | ${r.treatment} | ${esc(r.owner_name||'-')} |`).join('\n');

  const treatments = await db.prepare(`SELECT t.title, t.owner_name, t.due_date, t.status, r.title AS risk_title FROM risk_treatments t INNER JOIN risks r ON r.id=t.risk_id WHERE t.workspace_id=? AND t.status NOT IN ('done')`).all(wsId);
  const treatments_table = '| Risk | Action | Owner | Due | Status |\n|------|--------|-------|-----|--------|\n'
    + treatments.map(t => `| ${esc(t.risk_title)} | ${esc(t.title)} | ${esc(t.owner_name||'-')} | ${t.due_date||'-'} | ${t.status} |`).join('\n');

  const accs = await db.prepare(`SELECT a.*, r.title FROM risk_acceptances a INNER JOIN risks r ON r.id=a.risk_id WHERE a.workspace_id=? AND a.revoked_at IS NULL ORDER BY a.signed_at DESC NULLS LAST`).all(wsId);
  const acceptances_table = '| Risk | Accepter | Rationale | Expires |\n|------|----------|-----------|---------|\n'
    + (accs.length ? accs.map(a => `| ${esc(a.title)} | ${esc(a.accepter_name)} | ${esc(a.rationale).slice(0,80)} | ${a.expires_at||'-'} |`).join('\n') : '| - | - | - | - |');

  const open_majors = await db.prepare(`SELECT id, title, due_date FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified') ORDER BY id`).all(wsId);
  const ncs_table = '| ID | Title | Due |\n|----|-------|-----|\n' + (open_majors.length ? open_majors.map(n => `| NC-${String(n.id).padStart(3,'0')} | ${esc(n.title)} | ${n.due_date||'-'} |`).join('\n') : '| - | None | - |');

  const audits = await db.prepare(`SELECT title, audit_date, auditor_name, status FROM audits WHERE workspace_id=? ORDER BY audit_date NULLS FIRST`).all(wsId);
  const audits_table = '| Title | Date | Auditor | Status |\n|-------|------|---------|--------|\n'
    + audits.map(a => `| ${esc(a.title)} | ${a.audit_date||'-'} | ${esc(a.auditor_name||'-')} | ${a.status} |`).join('\n');
  const coverage = await db.prepare(`SELECT i.category, COUNT(DISTINCT f.id) AS findings FROM iso_items i LEFT JOIN audit_findings f ON f.iso_item_id=i.id INNER JOIN audits a ON a.id=f.audit_id WHERE a.workspace_id=? AND i.type='control' GROUP BY i.category ORDER BY i.category NULLS FIRST`).all(wsId);
  const coverage_table = '| Category | Findings |\n|----------|----------|\n'
    + coverage.map(c => `| ${c.category} | ${c.findings} |`).join('\n');

  const calendar = [];
  (await db.prepare(`SELECT 'doc_review' AS k, name AS title, next_review_date AS d FROM generated_docs WHERE workspace_id=? AND next_review_date IS NOT NULL AND next_review_date <= utc_date_text(now() + ('+90 days')::interval)`).all(wsId)).forEach(r => calendar.push(r));
  (await db.prepare(`SELECT 'nc_due' AS k, title, due_date AS d FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date <= utc_date_text(now() + ('+90 days')::interval)`).all(wsId)).forEach(r => calendar.push(r));
  (await db.prepare(`SELECT 'task_due' AS k, title, due_date AS d FROM tasks WHERE workspace_id=? AND status != 'done' AND due_date IS NOT NULL AND due_date <= utc_date_text(now() + ('+90 days')::interval)`).all(wsId)).forEach(r => calendar.push(r));
  calendar.sort((a, b) => (a.d || '').localeCompare(b.d || ''));
  const calendar_table = '| Date | Type | Item |\n|------|------|------|\n'
    + (calendar.length ? calendar.map(r => `| ${r.d} | ${r.k} | ${esc(r.title)} |`).join('\n') : '| - | - | Nothing in the next 90 days. |');

  const high_flags_count = (await db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')`).get(wsId)).c;
  const stage1 = Math.round((((totals.implemented || 0) + (totalItems - (totals.total || 0))) / totalItems) * 100);
  const stage2 = stage1;
  const stage1_verdict = stage1 >= 75 ? 'ready' : stage1 >= 50 ? 'partially ready (gaps remaining)' : 'not yet ready';

  return {
    workspace: ws, today, year,
    metrics: { implemented: totals.implemented || 0, totalItems },
    readiness: {
      stage1, stage2, high_flags_count,
      records: { mandatory: { found: 0, total: 0 } }
    },
    soa, findings,
    last_mrm_date: last_mrm ? last_mrm.meeting_date : '-',
    last_audit_date: last_audit ? last_audit.audit_date : '-',
    records_table, top_risks_table, treatments_table, acceptances_table,
    ncs_table, audits_table, coverage_table, calendar_table,
    stage1_verdict
  };
}

function render(body, ctx) {
  return body.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    const parts = key.split('.');
    let v = ctx;
    for (const p of parts) {
      if (v == null) return '';
      v = v[p];
    }
    return v == null ? '' : String(v);
  });
}

module.exports = { buildContext, render };
