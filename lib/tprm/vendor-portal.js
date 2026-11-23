'use strict';

const questionnaires = require('./questionnaires');
const conditionLinks = require('./condition-links');
const vendorPeople = require('./vendor-people');

const TYPE_LABELS = Object.freeze({ onboarding: 'Onboarding review', reassessment: 'Periodic review' });

async function assessmentFor(db, session, assessmentId) {
  const id = Number(assessmentId);
  if (!session || !Number.isSafeInteger(id) || id < 1) return null;
  const row = await db.prepare(`SELECT a.id, a.workspace_id, a.third_party_id, a.status FROM tp_assessments a WHERE a.id = ? AND a.status <> 'cancelled'`).get(id);
  if (!row) return null;
  const person = session.people.find(p => p.workspace_id === Number(row.workspace_id) && p.third_party_id === Number(row.third_party_id));
  if (!person) return null;
  return { assessmentId: id, workspaceId: Number(row.workspace_id), thirdPartyId: Number(row.third_party_id), person };
}

const questionnaireKey = (db, a) => questionnaires.questionnaireKeyFor(db, a.workspaceId, a.assessmentId);
const conditionsKey = (db, a) => conditionLinks.conditionsKeyFor(db, a.workspaceId, a.assessmentId);

function canSubmit(person, linkRecipientEmail) {
  if (!person) return true;
  return person.role === 'main' || (!!linkRecipientEmail && person.email === String(linkRecipientEmail).trim().toLowerCase());
}

async function firmBrand(db, firmId) {
  const letterhead = require('./letterhead');
  const lh = await letterhead.getLetterhead(db, firmId).catch(() => null);
  const firm = await db.prepare('SELECT name FROM firms WHERE id = ?').get(firmId);
  return {
    name: (lh && lh.displayName) || (firm && firm.name) || '',
    logo: lh && lh.logo ? await letterhead.logoDataUri(db, firmId).catch(() => null) : null,
    colour: lh && /^#[0-9a-f]{6}$/.test(String(lh.accent || '')) ? lh.accent : null,
  };
}

async function assessmentsOf(db, person) {
  const rows = await db.prepare(`SELECT a.id, a.type, a.status, a.created_at,
      q.status AS q_status, q.vendor_question_count, q.submitted_at,
      (SELECT COUNT(*)::int FROM tp_answers x WHERE x.workspace_id = a.workspace_id AND x.questionnaire_id = q.id AND x.response IS NOT NULL) AS answered,
      (SELECT r.expires_at FROM tp_vendor_requests r WHERE r.workspace_id = a.workspace_id AND r.assessment_id = a.id AND r.status IN ('active', 'submitted')
        AND r.expires_at > now() ORDER BY r.created_at DESC LIMIT 1) AS link_until,
      (SELECT r.status FROM tp_vendor_requests r WHERE r.workspace_id = a.workspace_id AND r.assessment_id = a.id AND r.status IN ('active', 'submitted')
        AND r.expires_at > now() ORDER BY r.created_at DESC LIMIT 1) AS link_status,
      (SELECT COUNT(*)::int FROM tp_issues i WHERE i.workspace_id = a.workspace_id AND i.assessment_id = a.id AND i.status <> 'withdrawn') AS issues,
      (SELECT COUNT(*)::int FROM tp_issues i WHERE i.workspace_id = a.workspace_id AND i.assessment_id = a.id AND i.status = 'open') AS issues_waiting,
      (SELECT l.expires_at FROM tp_condition_links l WHERE l.workspace_id = a.workspace_id AND l.assessment_id = a.id AND l.status = 'active'
        AND l.expires_at > now() ORDER BY l.created_at DESC LIMIT 1) AS conditions_until,
      (SELECT COUNT(*)::int FROM tp_clarifications c WHERE c.workspace_id = a.workspace_id AND c.questionnaire_id = q.id AND c.status = 'open') AS followups,
      (SELECT COUNT(*)::int FROM tp_condition_links l JOIN tp_conditions c ON c.workspace_id = l.workspace_id AND c.recommendation_id = l.recommendation_id
        WHERE l.workspace_id = a.workspace_id AND l.assessment_id = a.id AND l.status = 'active' AND l.expires_at > now()
          AND c.owner = 'vendor' AND c.status IN ('open', 'changes_requested')
          AND NOT EXISTS (SELECT 1 FROM tp_condition_proofs p WHERE p.workspace_id = c.workspace_id AND p.condition_id = c.id AND p.review_status = 'pending')) AS conditions_needing_proof,
      (SELECT string_agg(DISTINCT COALESCE(pp.name, vr.recipient_name), ', ') FROM tp_answers x
        LEFT JOIN tp_vendor_people pp ON pp.id = x.saved_by_person_id
        LEFT JOIN tp_vendor_requests vr ON vr.workspace_id = x.workspace_id AND vr.id = x.saved_by_request_id
        WHERE x.workspace_id = a.workspace_id AND x.questionnaire_id = q.id AND x.saved_at IS NOT NULL) AS answered_by
    FROM tp_assessments a
    LEFT JOIN tp_questionnaires q ON q.workspace_id = a.workspace_id AND q.assessment_id = a.id
    WHERE a.workspace_id = ? AND a.third_party_id = ? AND a.status <> 'cancelled'
    ORDER BY a.created_at DESC LIMIT 20`).all(person.workspace_id, person.third_party_id);
  const files = rows.length ? await db.prepare(`SELECT e.assessment_id, e.original_name, e.size_bytes, e.uploaded_at FROM tp_evidence e
    WHERE e.workspace_id = ? AND e.source = 'vendor' AND e.assessment_id IN (${rows.map(() => '?').join(',')}) ORDER BY e.uploaded_at DESC`)
    .all(person.workspace_id, ...rows.map(r => r.id)) : [];
  return rows.map(r => {
    const answering = r.link_status === 'active' && ['sent', 'in_progress'].includes(r.q_status);
    return {
      id: Number(r.id),
      typeLabel: TYPE_LABELS[r.type] || 'Review',
      name: `${TYPE_LABELS[r.type] || 'Review'} ${new Date(r.created_at).getUTCFullYear()}`,
      status: reviewStatus(r.status, r.q_status, answering),
      startedAt: r.created_at,
      followups: r.followups || 0,
      conditionsNeedingProof: r.conditions_needing_proof || 0,
      answeredBy: r.answered_by || '',
      questionnaire: !r.q_status || r.q_status === 'draft' ? null : {
        state: answering ? 'answering' : r.submitted_at ? 'submitted' : 'closed',
        open: !!r.link_status,
        until: r.link_until,
        answered: r.answered,
        total: r.vendor_question_count || 0,
        submittedAt: r.submitted_at,
      },
      issues: { total: r.issues, waiting: r.issues_waiting },
      conditionsUntil: r.conditions_until,
      files: files.filter(f => Number(f.assessment_id) === Number(r.id)).map(f => ({ name: f.original_name, size: Number(f.size_bytes), at: f.uploaded_at })),
    };
  });
}

const CLOSED_FOR_VENDOR = Object.freeze(['recommendation_issued', 'completed']);

function reviewStatus(assessmentStatus, questionnaireStatus, answering) {
  if (CLOSED_FOR_VENDOR.includes(assessmentStatus)) return 'Closed';
  if (answering) return 'In progress';
  if (!questionnaireStatus || questionnaireStatus === 'draft') return 'Not started';
  if (questionnaireStatus === 'sent' || questionnaireStatus === 'in_progress') return 'In progress';
  return 'Under review';
}

async function issuesOf(db, person) {
  const issues = require('./issues');
  const rows = await db.prepare(`SELECT i.id, i.title, i.status, to_char(i.agreed_date, 'YYYY-MM-DD') AS agreed_date, i.shared_at, a.id AS assessment_id, a.type, a.created_at
    FROM tp_issues i JOIN tp_assessments a ON a.workspace_id = i.workspace_id AND a.id = i.assessment_id
    WHERE i.workspace_id = ? AND a.third_party_id = ? AND i.status <> 'withdrawn' AND a.status <> 'cancelled'
    ORDER BY (i.status = 'open') DESC, i.shared_at DESC`).all(person.workspace_id, person.third_party_id);
  return rows.map(r => ({
    id: Number(r.id), title: r.title, status: r.status, label: issues.VENDOR_STATUS_LABELS[r.status] || '', agreedDate: r.agreed_date, sharedAt: r.shared_at,
    review: `${TYPE_LABELS[r.type] || 'Review'} ${new Date(r.created_at).getUTCFullYear()}`, assessmentId: Number(r.assessment_id),
    clientName: person.client_name, thirdPartyName: person.third_party_name,
  }));
}

async function homeData(db, session) {
  const groups = [];
  for (const person of session.people) {
    groups.push({
      person,
      clientName: person.client_name,
      thirdPartyName: person.third_party_name,
      people: await vendorPeople.list(db, person.workspace_id, person.third_party_id),
      assessments: await assessmentsOf(db, person),
    });
  }
  const reviews = [];
  const issueRows = [];
  const todo = [];
  for (const g of groups) {
    for (const a of g.assessments) {
      reviews.push({ ...a, clientName: g.clientName, thirdPartyName: g.thirdPartyName });
      const q = a.questionnaire;
      if (q && q.state === 'answering' && q.answered < q.total) {
        todo.push({ text: `Answer ${q.total - q.answered} ${q.total - q.answered === 1 ? 'question' : 'questions'} in ${a.name} for ${g.clientName}`, href: `/vendor/p/a/${a.id}`, when: q.until, whenLabel: 'Due' });
      }
      if (a.followups && q && q.open) todo.push({ text: `Answer ${a.followups} follow-up ${a.followups === 1 ? 'question' : 'questions'} in ${a.name}`, href: `/vendor/p/a/${a.id}`, when: null });
      if (a.conditionsUntil && a.conditionsNeedingProof) todo.push({ text: `Send proof for ${a.conditionsNeedingProof} ${a.conditionsNeedingProof === 1 ? 'condition' : 'conditions'} of ${a.name}`, href: `/vendor/p/a/${a.id}/c`, when: a.conditionsUntil, whenLabel: 'Link works until' });
    }
    const rows = await issuesOf(db, g.person);
    for (const i of rows) {
      issueRows.push(i);
      if (i.status === 'open') todo.push({ text: `Reply to the issue "${i.title}"`, href: `/vendor/p/a/${i.assessmentId}/issues#issue-${i.id}`, when: i.sharedAt, whenLabel: 'Shared' });
    }
  }
  return { email: session.email, firm: await firmBrand(db, session.firmId), groups, reviews, issues: issueRows, todo,
    manyOrgs: new Set(groups.map(g => g.thirdPartyName)).size > 1, roleLabels: vendorPeople.ROLE_LABELS, scoped: !!session.scopedTo };
}

const DEFAULT_COLOUR = '#1f4e5f';

function darker(hex, f = 0.28) {
  const n = parseInt(hex.slice(1), 16);
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.round(v * (1 - f)).toString(16).padStart(2, '0')).join('');
}

function brandShades(colour) {
  const base = /^#[0-9a-f]{6}$/i.test(String(colour || '')) ? String(colour).toLowerCase() : DEFAULT_COLOUR;
  return { base, deep: darker(base) };
}

async function frameFor(db, { firm, session = null, person = null, workspaceId = null, thirdPartyId = null, reviewer = null, active = null,
  linkHome = null, review = null } = {}) {
  const tp = workspaceId && thirdPartyId ? await db.prepare('SELECT name FROM tp_third_parties WHERE workspace_id = ? AND id = ?').get(workspaceId, thirdPartyId) : null;
  const orgs = session ? [...new Set(session.people.map(p => p.third_party_name))] : [];
  const items = [];
  if (session) {
    const waiting = session.people.length ? (await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_issues i
      JOIN tp_assessments a ON a.workspace_id = i.workspace_id AND a.id = i.assessment_id
      WHERE i.status = 'open' AND (${session.people.map(() => '(a.workspace_id = ? AND a.third_party_id = ?)').join(' OR ')})`)
      .get(...session.people.flatMap(p => [p.workspace_id, p.third_party_id]))).n : 0;
    items.push({ key: 'home', label: 'All reviews', href: '/vendor/p/home', go: 'home' });
    items.push({ key: 'issues', label: 'Issues', href: '/vendor/p/issues', go: 'pissues', count: waiting || null });
    items.push({ key: 'files', label: 'Files', href: '/vendor/p/files', go: 'files' });
    items.push({ key: 'people', label: 'People', href: '/vendor/p/people', go: 'people' });
  } else {
    if (linkHome) {
      for (const [key, label, go, to] of [['home', 'All reviews', 'home', 'home'], ['issues', 'Issues', 'pissues', 'issues'], ['files', 'Files', 'files', 'files'], ['people', 'People', 'people', 'people']]) {
        items.push({ key, label, go, post: { action: linkHome.action, aft: linkHome.aft, to } });
      }
    }
    if (review && review.label) items.push({ key: 'review', label: review.label, href: review.base, go: 'start', current: true });
  }
  if (!session && review && !review.label) {
    items.push({ key: 'review', label: 'Questionnaire', href: review.base, go: 'start', sub: !!linkHome });
    if (review.issues) items.push({ key: 'rissues', label: 'Issues', href: `${review.base}/issues`, go: 'issues', count: review.issuesWaiting || null, sub: !!linkHome });
  }
  for (const it of items) it.current = it.current || it.key === active;
  return {
    brand: brandShades(firm && firm.colour),
    firm: { name: (firm && firm.name) || '', logo: (firm && firm.logo) || null },
    orgName: !session ? '' : tp ? tp.name : orgs.length === 1 ? orgs[0] : orgs.length ? orgs.join(', ') : '',
    items,
    reviewer: reviewer && reviewer.email ? reviewer : null,
    me: session && person ? { name: person.name } : session ? { name: session.people[0] ? session.people[0].name : session.email } : null,
    signOutAft: session ? require('./vendor-answers').formToken(`home:${session.tokenHash}`) : null,
    linkHome,
    group: review && review.group ? review.group : 'This review',
  };
}

async function filesData(db, session) {
  const vendorAnswers = require('./vendor-answers');
  const out = [];
  for (const person of session.people) {
    const rows = await db.prepare(`SELECT a.id, a.type, a.created_at, q.id AS questionnaire_id, q.status AS q_status
      FROM tp_assessments a JOIN tp_questionnaires q ON q.workspace_id = a.workspace_id AND q.assessment_id = a.id
      WHERE a.workspace_id = ? AND a.third_party_id = ? AND a.status <> 'cancelled' AND q.status <> 'draft'
      ORDER BY a.created_at DESC LIMIT 20`).all(person.workspace_id, person.third_party_id);
    for (const r of rows) {
      const a = { assessmentId: Number(r.id), workspaceId: person.workspace_id, thirdPartyId: person.third_party_id, person };
      const key = await questionnaireKey(db, a);
      const ctx = key ? await vendorAnswers.linkContext(db, key) : null;
      const answering = !!(ctx && ctx.mode === 'answering');
      const files = await vendorAnswers.shelfRows(db, { workspaceId: person.workspace_id, assessmentId: Number(r.id), questionnaireId: Number(r.questionnaire_id) });
      out.push({
        id: Number(r.id), name: `${TYPE_LABELS[r.type] || 'Review'} ${new Date(r.created_at).getUTCFullYear()}`, clientName: person.client_name,
        thirdPartyName: person.third_party_name, answering, tokenHash: answering ? ctx.tokenHash : null,
        files: files.map(f => ({ ...f, deletable: answering && f.deletable })),
      });
    }
  }
  return out;
}

module.exports = { filesData, brandShades, frameFor, reviewStatus, assessmentFor, questionnaireKey, conditionsKey, canSubmit, firmBrand, homeData };
