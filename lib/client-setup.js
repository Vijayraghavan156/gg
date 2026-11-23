'use strict';

const { FRAMEWORK_REGISTRY } = require('./frameworks');

const NOT_STARTED = 'not_started';
const IN_PROGRESS = 'in_progress';
const COMPLETE = 'complete';

const SEEDED_QUESTION = 'cert-deadline';

const PLACEHOLDER_SCOPE = '%- not answered]%';

const ISO27001_REQUIRED = [
  'org-name', 'business-summary', 'cert-driver', 'products-in-scope', 'infra-model',
  'data-types', 'headcount-total', 'isms-owner', 'isms-coordinator', 'key-customers',
  'key-suppliers', 'crown-jewel-1',
];

async function one(db, sql, ...params) {
  try { return (await db.prepare(sql).get(...params)) || null; } catch (_) { return null; }
}

async function count(db, sql, ...params) {
  const row = await one(db, sql, ...params);
  return row ? Number(Object.values(row)[0] || 0) : 0;
}

async function iso27001Step(db, ws) {
  const answered = await count(db, `SELECT COUNT(*) c FROM engagement_intake
    WHERE workspace_id=? AND question_id<>? AND answer IS NOT NULL AND length(trim(answer))>0`,
    ws.id, SEEDED_QUESTION);
  const required = await count(db, `SELECT COUNT(*) c FROM engagement_intake
    WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer))>0
      AND question_id IN (${ISO27001_REQUIRED.map(() => '?').join(',')})`,
    ws.id, ...ISO27001_REQUIRED);
  const confirmed = await one(db, `SELECT scope_confirmed_at FROM workspaces
    WHERE id=? AND scope_confirmed_at IS NOT NULL
      AND scope IS NOT NULL AND length(trim(scope))>10 AND scope NOT ILIKE ?`,
    ws.id, PLACEHOLDER_SCOPE);

  if (confirmed) {
    return { status: COMPLETE, detail: `Scope signed off ${String(confirmed.scope_confirmed_at).slice(0, 10)}.` };
  }
  if (required >= ISO27001_REQUIRED.length) {
    return {
      status: IN_PROGRESS,
      detail: 'Every required answer is captured. Confirm the scope statement to sign it off.',
      note: 'Confirming needs the workspace.update permission.',
    };
  }
  if (answered > 0) {
    return { status: IN_PROGRESS, detail: `${required} of ${ISO27001_REQUIRED.length} required answers captured.` };
  }
  return { status: NOT_STARTED, detail: `${ISO27001_REQUIRED.length} required answers, then scope sign-off.` };
}

const PROGRAMME_STEPS = {
  iso27001: { label: 'Engagement intake and scope sign-off', href: ws => `/workspaces/${ws.id}/intake`, build: iso27001Step },
};

async function clientSetup(db, ws) {
  const codes = Array.isArray(ws.frameworks) ? ws.frameworks : [];
  const steps = [];

  for (const code of codes) {
    const spec = PROGRAMME_STEPS[code];
    const meta = FRAMEWORK_REGISTRY[code];
    if (!spec || !meta) continue;
    const built = spec.build(db, ws) || {};
    steps.push({
      key: code,
      kind: 'programme',
      programme: meta.shortLabel,
      label: spec.label,
      href: built.href || spec.href(ws),
      status: built.status || NOT_STARTED,
      detail: built.detail || '',
      note: built.note || null,
      order: meta.order,
    });
  }

  steps.sort((a, b) => a.order - b.order);
  const complete = steps.filter(s => s.status === COMPLETE).length;
  return {
    steps,
    total: steps.length,
    complete,
    outstanding: steps.length - complete,
    pct: steps.length ? Math.round(complete * 100 / steps.length) : 100,
    nextStep: [
      s => s.kind === 'programme' && s.status === IN_PROGRESS,
      s => s.kind === 'programme' && s.status === NOT_STARTED,
      s => s.status === IN_PROGRESS,
      s => s.status === NOT_STARTED,
    ].reduce((found, match) => found || steps.find(match) || null, null),
    done: steps.length > 0 && complete === steps.length,
  };
}

async function needsSetup(db, ws) {
  if (ws.scope && String(ws.scope).trim().length > 0) return false;
  const programmes = (await clientSetup(db, ws)).steps.filter(step => step.kind === 'programme');
  if (!programmes.length) return false;
  return programmes.every(step => step.status === NOT_STARTED);
}

module.exports = {
  clientSetup,
  needsSetup,
  NOT_STARTED,
  IN_PROGRESS,
  COMPLETE,
  ISO27001_REQUIRED,
  SEEDED_QUESTION,
};
