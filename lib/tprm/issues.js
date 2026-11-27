'use strict';

const access = require('./access');
const assessments = require('./assessments');
const events = require('./events');
const questionnaires = require('./questionnaires');
const { TprmError } = require('./errors');

const STATUSES = Object.freeze(['open', 'proposed', 'agreed', 'withdrawn']);
const STATUS_LABELS = Object.freeze({
  open: 'Waiting for the third party',
  proposed: 'Fix proposed, waiting for the reviewers',
  agreed: 'Fix agreed',
  withdrawn: 'Withdrawn',
});
const VENDOR_STATUS_LABELS = Object.freeze({
  open: 'Response needed',
  proposed: 'Fix proposed',
  agreed: 'Fix agreed',
});
const VENDOR_CLOSED_LABEL = 'Closed';
const LIMITS = Object.freeze({ title: 200, body: 4000, fix: 2000, name: 200 });
const CLOSED = Object.freeze(['cancelled', 'completed']);

const str = v => (typeof v === 'string' ? v.trim() : '');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });
const notFound = () => new TprmError(404, 'This issue does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409, 'Someone else changed this issue after you opened it. Nothing was saved: reload the page and try again.');
const ymd = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

function requireManage(actor) {
  if (!actor || !access.can(actor.user, actor.perms, 'tp.manage')) {
    throw new TprmError(403, 'Your role does not allow sharing issues with the third party.');
  }
}

function realDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

async function append(db, workspaceId, assessment, actorId, action, before, after) {
  await events.appendEvent(db, {
    workspaceId, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id, actorId, action, before, after,
  });
}

async function openAssessment(db, actor, thirdPartyId, assessmentId) {
  const assessment = await assessments.getAssessment(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
  if (CLOSED.includes(assessment.status)) throw new TprmError(409, 'This assessment is closed, so issues can no longer be shared or changed.');
  return assessment;
}

const AUDIENCE = Object.freeze({ firm: '', vendor: ' AND NOT internal', client: ' AND client_visible' });

async function messagesOf(db, workspaceId, issueIds, audience = 'firm') {
  if (!issueIds.length) return new Map();
  const filter = AUDIENCE[audience];
  if (filter === undefined) throw new Error('Unknown audience');
  const rows = await db.prepare(`SELECT id, issue_id, author_kind, author_user_id, author_name, body, proposed_fix,
      to_char(proposed_date, 'YYYY-MM-DD') AS proposed_date, created_at, internal, client_visible
    FROM tp_issue_messages WHERE workspace_id = ? AND issue_id IN (${issueIds.map(() => '?').join(',')})${filter} ORDER BY id`)
    .all(workspaceId, ...issueIds);
  const map = new Map();
  for (const r of rows) {
    const k = Number(r.issue_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

const ISSUE_COLUMNS = `i.id, i.workspace_id, i.assessment_id, i.finding_id, i.title, i.body, i.status, i.agreed_fix,
  to_char(i.agreed_date, 'YYYY-MM-DD') AS agreed_date, i.agreed_at, i.shared_at, i.withdrawn_at, i.row_version`;

function withThread(row, threads) {
  const messages = threads.get(Number(row.id)) || [];
  const proposals = messages.filter(m => m.author_kind === 'third_party' && m.proposed_fix);
  return { ...row, messages, latestProposal: proposals.length ? proposals[proposals.length - 1] : null };
}

async function forAssessment(db, workspaceId, assessmentId) {
  const rows = await db.prepare(`SELECT ${ISSUE_COLUMNS}, u.name AS shared_by_name FROM tp_issues i
    LEFT JOIN users u ON u.id = i.shared_by WHERE i.workspace_id = ? AND i.assessment_id = ? ORDER BY i.id`).all(workspaceId, assessmentId);
  const threads = await messagesOf(db, workspaceId, rows.map(r => Number(r.id)));
  return rows.map(r => withThread(r, threads));
}

async function liveIssueFor(db, workspaceId, findingId) {
  const row = await db.prepare("SELECT id FROM tp_issues WHERE workspace_id = ? AND finding_id = ? AND status <> 'withdrawn'").get(workspaceId, Number(findingId) || 0);
  return row ? Number(row.id) : null;
}

function parseShare(input) {
  const title = str(input.title);
  const body = str(input.body);
  const errors = [];
  if (!title) errors.push('Write the title the third party will see.');
  else if (title.length > LIMITS.title) errors.push(`The title must be ${LIMITS.title} characters or fewer.`);
  if (!body) errors.push('Write what the third party needs to know about this issue.');
  else if (body.length > LIMITS.body) errors.push(`The text must be ${LIMITS.body} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  return { title, body };
}

async function share(db, actor, thirdPartyId, assessmentId, findingId, input = {}) {
  requireManage(actor);
  const values = parseShare(input);
  return await db.transaction(async () => {
    const assessment = await openAssessment(db, actor, thirdPartyId, assessmentId);
    const finding = await db.prepare('SELECT id, status FROM tp_findings WHERE workspace_id = ? AND assessment_id = ? AND id = ? FOR UPDATE')
      .get(actor.ws.id, assessment.id, Number(findingId) || 0);
    if (!finding) throw notFound();
    const existing = await db.prepare('SELECT id, status FROM tp_issues WHERE workspace_id = ? AND finding_id = ? FOR UPDATE').get(actor.ws.id, finding.id);
    let id;
    if (existing && existing.status !== 'withdrawn') throw new TprmError(409, 'This finding is already shared with the third party.');
    if (existing) {
      await db.prepare(`UPDATE tp_issues SET title = ?, body = ?, status = 'open', agreed_fix = NULL, agreed_date = NULL, agreed_by = NULL,
          agreed_at = NULL, shared_by = ?, shared_at = now(), withdrawn_by = NULL, withdrawn_at = NULL, updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ?`).run(values.title, values.body, actor.user.id, actor.ws.id, existing.id);
      id = Number(existing.id);
    } else {
      id = Number((await db.prepare(`INSERT INTO tp_issues (workspace_id, assessment_id, finding_id, title, body, shared_by)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(actor.ws.id, assessment.id, finding.id, values.title, values.body, actor.user.id)).id);
    }
    await append(db, actor.ws.id, assessment, actor.user.id, 'issue.shared', null, { issue_id: id, finding_id: Number(finding.id), title: values.title });
    return { issueId: id, assessment };
  })();
}

async function loadIssue(db, workspaceId, assessmentId, issueId) {
  const row = await db.prepare(`SELECT ${ISSUE_COLUMNS} FROM tp_issues i WHERE i.workspace_id = ? AND i.assessment_id = ? AND i.id = ? FOR UPDATE`)
    .get(workspaceId, assessmentId, Number(issueId) || 0);
  if (!row) throw notFound();
  return row;
}

function checkVersion(row, input) {
  if (input.row_version === undefined || input.row_version === '' || Number(input.row_version) !== Number(row.row_version)) throw conflict();
}

async function firmReply(db, actor, thirdPartyId, assessmentId, issueId, input = {}) {
  requireManage(actor);
  const body = str(input.body);
  if (!body) throw invalid(['Write your reply.']);
  if (body.length > LIMITS.body) throw invalid([`The reply must be ${LIMITS.body} characters or fewer.`]);
  const internal = input.internal === '1' || input.internal === true;
  return await db.transaction(async () => {
    const assessment = await assessments.getAssessment(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
    const issue = await loadIssue(db, actor.ws.id, assessment.id, issueId);
    if (issue.status === 'withdrawn') throw new TprmError(409, 'This issue was withdrawn.');
    const finding = await db.prepare('SELECT status FROM tp_findings WHERE workspace_id = ? AND id = ?').get(actor.ws.id, issue.finding_id);
    const shut = require('./finding-comments').closedReason(finding ? finding.status : 'closed', assessment.status);
    if (shut) throw new TprmError(409, shut);
    await db.prepare(`INSERT INTO tp_issue_messages (workspace_id, issue_id, author_kind, author_user_id, author_name, body, internal, client_visible)
      VALUES (?, ?, 'firm', ?, ?, ?, ?, ?)`).run(actor.ws.id, issue.id, actor.user.id, String(actor.user.name || '').slice(0, LIMITS.name) || null, body, internal, !internal);
    await db.prepare('UPDATE tp_issues SET updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?').run(actor.ws.id, issue.id);
    await append(db, actor.ws.id, assessment, actor.user.id, internal ? 'issue.noted_internally' : 'issue.replied', null, { issue_id: Number(issue.id), title: issue.title });
    return { issueId: Number(issue.id), assessment, internal };
  })();
}

async function nextPosition(db, workspaceId, recommendationId) {
  return Number((await db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM tp_conditions WHERE workspace_id = ? AND recommendation_id = ?')
    .get(workspaceId, recommendationId)).p);
}

async function agree(db, actor, thirdPartyId, assessmentId, issueId, input = {}) {
  requireManage(actor);
  return await db.transaction(async () => {
    const assessment = await openAssessment(db, actor, thirdPartyId, assessmentId);
    const issue = await loadIssue(db, actor.ws.id, assessment.id, issueId);
    checkVersion(issue, input);
    if (issue.status !== 'proposed') throw new TprmError(409, 'There is no proposed fix to agree on this issue.');
    const [proposal] = (await messagesOf(db, actor.ws.id, [Number(issue.id)])).get(Number(issue.id)).filter(m => m.author_kind === 'third_party' && m.proposed_fix).slice(-1);
    await db.prepare(`UPDATE tp_issues SET status = 'agreed', agreed_fix = ?, agreed_date = ?::date, agreed_by = ?, agreed_at = now(),
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
      .run(proposal.proposed_fix, proposal.proposed_date || null, actor.user.id, actor.ws.id, issue.id);
    const draft = await db.prepare(`SELECT id FROM tp_recommendations WHERE workspace_id = ? AND assessment_id = ? AND status = 'draft'
      ORDER BY version DESC LIMIT 1`).get(actor.ws.id, assessment.id);
    let conditionAdded = false;
    if (draft) {
      const exists = await db.prepare('SELECT 1 FROM tp_conditions WHERE workspace_id = ? AND recommendation_id = ? AND finding_id = ? AND description = ?')
        .get(actor.ws.id, draft.id, issue.finding_id, proposal.proposed_fix);
      if (!exists) {
        await db.prepare(`INSERT INTO tp_conditions (workspace_id, recommendation_id, position, description, owner, due_date, finding_id)
          VALUES (?, ?, ?, ?, 'vendor', ?::date, ?)`).run(actor.ws.id, draft.id, (await nextPosition(db, actor.ws.id, draft.id)) + 1,
          proposal.proposed_fix, proposal.proposed_date || null, issue.finding_id);
        conditionAdded = true;
      }
    }
    await append(db, actor.ws.id, assessment, actor.user.id, 'issue.agreed', { issue_id: Number(issue.id), status: issue.status },
      { issue_id: Number(issue.id), title: issue.title, agreed_fix: proposal.proposed_fix, agreed_date: proposal.proposed_date || null,
        condition_added: conditionAdded });
    return { issueId: Number(issue.id), conditionAdded, assessment };
  })();
}

async function withdraw(db, actor, thirdPartyId, assessmentId, issueId, input = {}) {
  requireManage(actor);
  return await db.transaction(async () => {
    const assessment = await openAssessment(db, actor, thirdPartyId, assessmentId);
    const issue = await loadIssue(db, actor.ws.id, assessment.id, issueId);
    checkVersion(issue, input);
    if (issue.status === 'withdrawn') return { issueId: Number(issue.id), assessment };
    await db.prepare(`UPDATE tp_issues SET status = 'withdrawn', agreed_fix = NULL, agreed_date = NULL, agreed_by = NULL, agreed_at = NULL,
        withdrawn_by = ?, withdrawn_at = now(), updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
      .run(actor.user.id, actor.ws.id, issue.id);
    await append(db, actor.ws.id, assessment, actor.user.id, 'issue.withdrawn', { issue_id: Number(issue.id), status: issue.status },
      { issue_id: Number(issue.id), title: issue.title, status: 'withdrawn' });
    return { issueId: Number(issue.id), assessment };
  })();
}

async function agreedFixes(db, workspaceId, assessmentId) {
  return (await db.prepare(`SELECT finding_id, agreed_fix, to_char(agreed_date, 'YYYY-MM-DD') AS agreed_date FROM tp_issues
    WHERE workspace_id = ? AND assessment_id = ? AND status = 'agreed' ORDER BY id`).all(workspaceId, assessmentId))
    .map(r => ({ description: r.agreed_fix, owner: 'vendor', due_date: r.agreed_date || null, finding_id: Number(r.finding_id) }));
}

async function vendorContext(db, token) {
  const tokenHash = questionnaires.keyHash(token);
  if (!tokenHash) return null;
  const row = await db.prepare(`SELECT r.id AS request_id, r.workspace_id, r.assessment_id, r.questionnaire_id, r.expires_at, r.recipient_name, r.recipient_email,
      a.third_party_id, a.status AS a_status, w.firm_id, w.client_name, w.brand_display_name
    FROM tp_vendor_requests r
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN workspaces w ON w.id = r.workspace_id
    JOIN tp_client_settings s ON s.workspace_id = r.workspace_id
    WHERE r.token_hash = ? AND r.status IN ('active', 'submitted') AND r.expires_at > now() AND s.enabled AND a.status <> 'cancelled'`).get(tokenHash);
  if (!row) return null;
  return {
    tokenHash,
    requestId: Number(row.request_id),
    workspaceId: Number(row.workspace_id),
    assessmentId: Number(row.assessment_id),
    questionnaireId: Number(row.questionnaire_id),
    thirdPartyId: Number(row.third_party_id),
    firmId: Number(row.firm_id),
    assessmentClosed: CLOSED.includes(row.a_status),
    expiresAt: row.expires_at,
    clientName: row.brand_display_name || row.client_name,
    recipientName: row.recipient_name || null,
    recipientEmail: row.recipient_email || null,
  };
}

async function vendorContextFor(db, a) {
  const row = await db.prepare(`SELECT a.id, a.workspace_id, a.third_party_id, a.status AS a_status, w.firm_id, w.client_name, w.brand_display_name,
      (SELECT r.id FROM tp_vendor_requests r WHERE r.workspace_id = a.workspace_id AND r.assessment_id = a.id ORDER BY r.created_at DESC LIMIT 1) AS request_id,
      (SELECT r.questionnaire_id FROM tp_vendor_requests r WHERE r.workspace_id = a.workspace_id AND r.assessment_id = a.id ORDER BY r.created_at DESC LIMIT 1) AS questionnaire_id
    FROM tp_assessments a
    JOIN workspaces w ON w.id = a.workspace_id
    JOIN tp_client_settings s ON s.workspace_id = a.workspace_id AND s.enabled
    WHERE a.workspace_id = ? AND a.id = ? AND a.third_party_id = ? AND a.status <> 'cancelled'`).get(a.workspaceId, a.assessmentId, a.thirdPartyId);
  if (!row) return null;
  return {
    tokenHash: `issues:${Number(row.id)}`,
    requestId: row.request_id ? Number(row.request_id) : null,
    workspaceId: Number(row.workspace_id),
    assessmentId: Number(row.id),
    questionnaireId: row.questionnaire_id ? Number(row.questionnaire_id) : null,
    thirdPartyId: Number(row.third_party_id),
    firmId: Number(row.firm_id),
    assessmentClosed: CLOSED.includes(row.a_status),
    expiresAt: null,
    clientName: row.brand_display_name || row.client_name,
    recipientName: a.person ? a.person.name : null,
    recipientEmail: a.person ? a.person.email : null,
  };
}

async function vendorList(db, vctx) {
  const rows = await db.prepare(`SELECT ${ISSUE_COLUMNS}, f.status AS finding_status, f.closed_at AS finding_closed_at
    FROM tp_issues i LEFT JOIN tp_findings f ON f.workspace_id = i.workspace_id AND f.id = i.finding_id
    WHERE i.workspace_id = ? AND i.assessment_id = ? AND i.status <> 'withdrawn' ORDER BY i.id`)
    .all(vctx.workspaceId, vctx.assessmentId);
  const threads = await messagesOf(db, vctx.workspaceId, rows.map(r => Number(r.id)), 'vendor');
  return rows.map(r => withThread(r, threads));
}

async function trackedConditions(db, workspaceId, assessmentId, findingIds) {
  const ids = [...new Set(findingIds.map(Number))].filter(n => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const rows = await db.prepare(`SELECT c.finding_id, c.position, c.status, c.due_date::text AS due_date, c.waive_until::text AS waive_until
    FROM tp_conditions c
    JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id AND r.status = 'issued'
    JOIN tp_client_decisions d ON d.workspace_id = r.workspace_id AND d.recommendation_id = r.id AND d.outcome = 'approve_with_conditions'
    WHERE c.workspace_id = ? AND r.assessment_id = ? AND c.owner = 'vendor' AND c.finding_id IN (${ids.map(() => '?').join(',')})
    ORDER BY c.position`).all(workspaceId, assessmentId, ...ids);
  const map = new Map();
  for (const r of rows) {
    const k = Number(r.finding_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

const NEXT_STEPS = Object.freeze({
  closed: 'Nothing more is needed: this issue is closed.',
  accepted: 'Your proof was accepted. Nothing more is needed.',
  waived: 'The condition was waived, so no proof is needed.',
  proof_sent: 'Your proof was sent. The reviewers are checking it.',
  changes_requested: 'The reviewers asked for changes to your proof. Send it again with your conditions link.',
  proof_due: 'Send proof that it is done with the conditions link you were emailed.',
  waiting: 'You will be asked for proof when it is done',
});

function supplierStage(issue, conditions, today) {
  if (issue.finding_status && issue.finding_status !== 'open') return 'closed';
  if (issue.status !== 'agreed') return null;
  if (!conditions || !conditions.length) return 'waiting';
  const { stateOf } = require('./conditions');
  const states = conditions.map(c => stateOf(c, today));
  if (states.some(s => s.status === 'changes_requested')) return 'changes_requested';
  if (states.some(s => s.canSubmit)) return 'proof_due';
  if (states.some(s => s.awaitingVerification)) return 'proof_sent';
  return states.some(s => s.status === 'verified') ? 'accepted' : 'waived';
}

const supplierCanReply = (issue, vctx) => !require('./finding-comments').closedReason(issue.finding_status || 'closed', vctx.assessmentClosed ? 'completed' : 'open');

async function vendorPage(db, vctx) {
  const letterhead = require('./letterhead');
  const lh = await letterhead.getLetterhead(db, vctx.firmId).catch(() => null);
  const list = await vendorList(db, vctx);
  const tracked = await trackedConditions(db, vctx.workspaceId, vctx.assessmentId, list.map(i => i.finding_id));
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(vctx.workspaceId);
  const today = require('../dates').todayFor(ws);
  return {
    clientName: vctx.clientName,
    recipientName: vctx.recipientName,
    expiresAt: vctx.expiresAt,
    closed: vctx.assessmentClosed,
    firm: {
      name: lh ? lh.displayName : '',
      logo: lh && lh.logo ? await letterhead.logoDataUri(db, vctx.firmId).catch(() => null) : null,
      colour: lh && /^#[0-9a-f]{6}$/.test(String(lh.accent || '')) ? lh.accent : null,
    },
    issues: list.map(i => {
      const stage = supplierStage(i, tracked.get(Number(i.finding_id)), today);
      const canReply = supplierCanReply(i, vctx);
      return {
        id: Number(i.id), title: i.title, body: i.body, status: i.status, label: stage === 'closed' ? VENDOR_CLOSED_LABEL : VENDOR_STATUS_LABELS[i.status] || '',
        stage, nextStep: stage ? NEXT_STEPS[stage] : null, closedAt: stage === 'closed' ? i.finding_closed_at : null,
        canReply, canPropose: canReply && !vctx.assessmentClosed && i.status !== 'agreed',
        agreedFix: i.agreed_fix, agreedDate: i.agreed_date, sharedAt: i.shared_at,
        messages: i.messages.map(m => ({ id: Number(m.id), mine: m.author_kind === 'third_party', name: m.author_kind === 'third_party' ? (m.author_name || 'You') : m.author_kind === 'client' ? [vctx.clientName, m.author_name].filter(Boolean).join(', ') : 'The reviewers',
          body: m.body, proposedFix: m.proposed_fix, proposedDate: m.proposed_date, at: m.created_at })),
      };
    }),
    limits: LIMITS,
  };
}

async function vendorCount(db, workspaceId, assessmentId) {
  const r = await db.prepare(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE i.status = 'open' AND f.status = 'open')::int AS waiting FROM tp_issues i
    LEFT JOIN tp_findings f ON f.workspace_id = i.workspace_id AND f.id = i.finding_id
    WHERE i.workspace_id = ? AND i.assessment_id = ? AND i.status <> 'withdrawn'`).get(workspaceId, assessmentId);
  return { total: r.n, waiting: r.waiting };
}

async function vendorRespond(db, vctx, issueId, input = {}, { person = null } = {}) {
  const body = str(input.body);
  const fix = str(input.proposed_fix);
  const date = str(input.proposed_date);
  const errors = [];
  if (!body && !fix) errors.push('Write a response, or propose a fix.');
  if (body.length > LIMITS.body) errors.push(`The response must be ${LIMITS.body} characters or fewer.`);
  if (fix.length > LIMITS.fix) errors.push(`The proposed fix must be ${LIMITS.fix} characters or fewer.`);
  if (fix && !date) errors.push('Give the date by which the fix will be done.');
  if (date && !realDate(date)) errors.push('Give a real date for the fix.');
  if (!fix && date) errors.push('Describe the fix the date is for.');
  if (errors.length) throw invalid(errors);
  return await db.transaction(async () => {
    const issue = await db.prepare(`SELECT ${ISSUE_COLUMNS}, f.status AS finding_status FROM tp_issues i
      LEFT JOIN tp_findings f ON f.workspace_id = i.workspace_id AND f.id = i.finding_id
      WHERE i.workspace_id = ? AND i.assessment_id = ? AND i.id = ? FOR UPDATE OF i`)
      .get(vctx.workspaceId, vctx.assessmentId, Number(issueId) || 0);
    if (!issue || issue.status === 'withdrawn') throw notFound();
    if (!supplierCanReply(issue, vctx)) throw new TprmError(409, 'This issue is closed, so responses can no longer be sent.');
    if (fix && issue.status === 'agreed') throw new TprmError(409, 'A fix is already agreed for this issue. Write a response instead.');
    if (fix && vctx.assessmentClosed) throw new TprmError(409, 'The review is completed, so a new fix can no longer be agreed here. Write a response instead.');
    const authorName = person ? person.name : vctx.recipientName;
    await db.prepare(`INSERT INTO tp_issue_messages (workspace_id, issue_id, author_kind, author_request_id, author_person_id, author_name, body, proposed_fix, proposed_date)
      VALUES (?, ?, 'third_party', ?, ?, ?, ?, ?, ?::date)`).run(vctx.workspaceId, issue.id, vctx.requestId, person ? person.id : null, authorName ? authorName.slice(0, LIMITS.name) : null,
      body || null, fix || null, fix ? date : null);
    const status = fix ? 'proposed' : issue.status;
    await db.prepare('UPDATE tp_issues SET status = ?, updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?')
      .run(status, vctx.workspaceId, issue.id);
    const assessment = { id: vctx.assessmentId, third_party_id: vctx.thirdPartyId };
    await append(db, vctx.workspaceId, assessment, null, fix ? 'issue.fix_proposed' : 'issue.vendor_replied', { issue_id: Number(issue.id), status: issue.status },
      { issue_id: Number(issue.id), title: issue.title, by: 'third_party', request_id: vctx.requestId, ...(person ? { by_person_id: person.id, by_name: person.name } : {}), ...(fix ? { proposed_fix: fix, proposed_date: date } : {}) });
    return { issueId: Number(issue.id), proposed: !!fix, title: issue.title };
  })();
}

async function clientThreads(db, ws, findingIds) {
  const ids = [...new Set((findingIds || []).map(Number))].filter(n => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const rows = await db.prepare(`SELECT ${ISSUE_COLUMNS}, a.status AS assessment_status, f.status AS finding_status FROM tp_issues i
    JOIN tp_assessments a ON a.workspace_id = i.workspace_id AND a.id = i.assessment_id
    LEFT JOIN tp_findings f ON f.workspace_id = i.workspace_id AND f.id = i.finding_id
    WHERE i.workspace_id = ? AND i.status <> 'withdrawn' AND i.finding_id IN (${ids.map(() => '?').join(',')})
      AND EXISTS (SELECT 1 FROM tp_recommendations r WHERE r.workspace_id = i.workspace_id AND r.assessment_id = i.assessment_id AND r.status = 'issued')`)
    .all(ws.id, ...ids);
  const threads = await messagesOf(db, ws.id, rows.map(r => Number(r.id)), 'client');
  const map = new Map();
  for (const r of rows) {
    const t = withThread(r, threads);
    const closedReason = require('./finding-comments').closedReason(r.finding_status, r.assessment_status);
    map.set(Number(r.finding_id), { ...t, open: !closedReason, closedReason });
  }
  return map;
}

async function clientComment(db, ws, user, issueId, input = {}) {
  const body = str(input.body);
  if (!body) throw invalid(['Write your comment.']);
  if (body.length > LIMITS.body) throw invalid([`The comment must be ${LIMITS.body} characters or fewer.`]);
  if (!user || !access.isClientUser(user)) throw notFound();
  return await db.transaction(async () => {
    const issue = await db.prepare(`SELECT ${ISSUE_COLUMNS}, a.status AS assessment_status, a.third_party_id, f.status AS finding_status FROM tp_issues i
      JOIN tp_assessments a ON a.workspace_id = i.workspace_id AND a.id = i.assessment_id
      LEFT JOIN tp_findings f ON f.workspace_id = i.workspace_id AND f.id = i.finding_id
      WHERE i.workspace_id = ? AND i.id = ? AND i.status <> 'withdrawn'
        AND EXISTS (SELECT 1 FROM tp_recommendations r WHERE r.workspace_id = i.workspace_id AND r.assessment_id = i.assessment_id AND r.status = 'issued')
      FOR UPDATE OF i`).get(ws.id, Number(issueId) || 0);
    if (!issue) throw notFound();
    const shut = require('./finding-comments').closedReason(issue.finding_status, issue.assessment_status);
    if (shut) throw new TprmError(409, shut);
    await db.prepare(`INSERT INTO tp_issue_messages (workspace_id, issue_id, author_kind, author_user_id, author_name, body, internal, client_visible)
      VALUES (?, ?, 'client', ?, ?, ?, false, true)`).run(ws.id, issue.id, user.id, String(user.name || '').slice(0, LIMITS.name) || null, body);
    await db.prepare('UPDATE tp_issues SET updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?').run(ws.id, issue.id);
    await append(db, ws.id, { id: Number(issue.assessment_id), third_party_id: Number(issue.third_party_id) }, user.id, 'issue.client_commented', null,
      { issue_id: Number(issue.id), title: issue.title });
    return { issueId: Number(issue.id), findingId: Number(issue.finding_id), thirdPartyId: Number(issue.third_party_id), assessmentId: Number(issue.assessment_id) };
  })();
}

module.exports = {
  STATUSES, STATUS_LABELS, VENDOR_STATUS_LABELS, VENDOR_CLOSED_LABEL, LIMITS,
  forAssessment, liveIssueFor, share, firmReply, clientThreads, clientComment, agree, withdraw, agreedFixes,
  vendorContext, vendorContextFor, vendorList, vendorPage, vendorCount, vendorRespond, ymd,
};
