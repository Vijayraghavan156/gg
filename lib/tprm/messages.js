'use strict';

const events = require('./events');
const format = require('./format');

const DAY = 24 * 3600 * 1000;
const OVERDUE_WINDOW_DAYS = 3;
const DECISION_REMINDER_DAYS = 7;
const DECISION_REMINDER_WINDOW_DAYS = 14;
const CONDITION_DUE_DAYS = 7;

const KIND_LABELS = Object.freeze({
  vendor_reminder_7: 'the reminder 7 days before the questionnaire link stops working',
  vendor_reminder_1: 'the reminder the day before the questionnaire link stops working',
  vendor_overdue: 'the notice that the questionnaire link stopped working unanswered',
  vendor_receipt: 'the receipt for the submitted questionnaire',
  vendor_clarification: 'the clarification question',
  conditions_link: 'the conditions link',
  consultant_submitted: 'the notice that the questionnaire was submitted',
  consultant_clarification_answered: 'the notice that a clarification was answered',
  consultant_client_decided: 'the client\'s decision',
  consultant_proof_uploaded: 'the notice that proof was sent for a condition',
  client_decision_needed: 'the request for a decision',
  client_decision_reminder: 'the reminder that a decision is waiting',
  client_condition_due: 'the notice that a condition is due',
  vendor_issue_shared: 'the notice that an issue was shared',
  consultant_issue_reply: 'the third party\'s response on an issue',
  vendor_sign_in_code: 'a sign-in code for the third-party portal',
  vendor_invited: 'the invitation to the third-party portal',
  vendor_sections_assigned: 'the sections a colleague was asked to answer',
  vendor_issue_update: 'the reviewers\' reply or agreed fix on an issue',
});
const ROLE_LABELS = Object.freeze({ third_party: 'the third party', consultant: 'the consultant', client: 'the client' });

const lazyEmail = () => require('../email');

function sealedLink(link, now = new Date()) {
  if (!link || !link.token_sealed || link.status !== 'active' || new Date(link.expires_at) <= now) return null;
  try {
    const token = require('../encryption').decrypt(link.token_sealed, link.workspace_id);
    return token ? { url: require('./questionnaires').linkUrl(token), token } : null;
  } catch (_) { return null; }
}
const redactionsOf = sealed => (sealed ? [sealed.url, sealed.token] : []);
const assessmentPath = b => `/tprm/clients/${b.ws.id}/third-parties/${b.a.third_party_id}/assessments/${b.a.id}`;
const portalRecPath = (b, rid) => `/workspaces/${b.ws.id}/client-portal/third-party-risk/recommendations/${rid}`;
const abs = p => `${lazyEmail().appBaseUrl()}${p}`;

async function base(db, workspaceId, assessmentId) {
  const a = await db.prepare(`SELECT a.*, t.name AS third_party_name FROM tp_assessments a
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    WHERE a.workspace_id = ? AND a.id = ?`).get(workspaceId, assessmentId);
  if (!a) return null;
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  const firm = ws ? await db.prepare('SELECT * FROM firms WHERE id = ?').get(ws.firm_id) : null;
  const lh = ws ? await require('./letterhead').getLetterhead(db, ws.firm_id).catch(() => null) : null;
  const f = format.forZone(format.zoneOf(ws, firm));
  return { a, ws, firm, f, clientName: ws.brand_display_name || ws.client_name, firmName: lh ? lh.displayName : '' };
}

async function userRow(db, id) {
  if (!id) return null;
  const u = await db.prepare('SELECT id, name, email, email_notify, active FROM users WHERE id = ?').get(id);
  return u && Number(u.active) !== 0 ? u : null;
}
const reachable = u => !!(u && u.email && u.email_notify !== 'off');

async function consultants(db, b, { includeAuthor = false, linkCreator = null } = {}) {
  const rec = await db.prepare(`SELECT author_id FROM tp_recommendations WHERE workspace_id = ? AND assessment_id = ?
    ORDER BY version DESC LIMIT 1`).get(b.ws.id, b.a.id);
  const ids = [b.a.lead_consultant_id, rec && rec.author_id, linkCreator].filter(Boolean).map(Number);
  const chosen = includeAuthor ? [...new Set(ids.slice(0, 2))] : ids.slice(0, 1);
  const out = [];
  for (const id of chosen) { const u = await userRow(db, id); if (u) out.push(u); }
  if (!out.length && !includeAuthor) for (const id of ids.slice(1)) { const u = await userRow(db, id); if (u) { out.push(u); break; } }
  return out;
}

async function contactFor(db, b, linkCreator = null) {
  const [u] = await consultants(db, b, { linkCreator });
  return u && u.email ? { name: u.name || '', email: u.email } : null;
}

async function deliver(db, b, { kind, key, role, to, data, redactions = [] }) {
  if (!to || !to.email) return { skipped: 'no_address' };
  if (process.env.EMAIL_DELIVERY_DISABLED === '1') return { skipped: 'disabled' };
  const chain = `tp_events:${b.ws.id}:assessment:${b.a.id}`;
  const claimed = await db.transaction(async () => {
    await db.lockChain(chain);
    const seen = await db.prepare(`SELECT 1 FROM tp_events WHERE workspace_id = ? AND chain_type = 'assessment' AND chain_id = ?
      AND action = 'message.sent' AND after_state->>'key' = ? LIMIT 1`).get(b.ws.id, b.a.id, key);
    if (seen) return false;
    await events.appendEvent(db, {
      workspaceId: b.ws.id, thirdPartyId: b.a.third_party_id, assessmentId: b.a.id, actorId: null, action: 'message.sent',
      after: { kind, key, to: role, recipient_name: to.name || null, ...(role === 'third_party' ? { recipient_email: to.email } : { user_id: Number(to.id) }) },
    });
    return true;
  })();
  if (!claimed) return { skipped: 'already_sent' };
  const email = lazyEmail();
  let result;
  try {
    const m = email.renderTprmEmail(kind, { toName: to.name || '', firmName: b.firmName, clientName: b.clientName, thirdPartyName: b.a.third_party_name, ...data });
    result = await email.sendEmail({ to: to.email, subject: m.subject, html: m.html, firmId: b.ws.firm_id, workspaceId: b.ws.id,
      relatedType: `tprm:${kind}`, relatedId: b.a.id, outboxRedactions: redactions });
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  if (!result.ok) {
    await events.appendEvent(db, { workspaceId: b.ws.id, thirdPartyId: b.a.third_party_id, assessmentId: b.a.id, actorId: null,
      action: 'message.failed', after: { kind, key, to: role, error: String(result.error || 'not sent').slice(0, 300) } }).catch(() => {});
  }
  return result;
}

async function safely(name, fn) {
  try { return await fn(); } catch (err) { console.error(`[tprm.messages.${name}]`, err && err.message); return null; }
}

function vendorSubmitted(db, { workspaceId, assessmentId, requestId, questionnaireId }) {
  return safely('vendorSubmitted', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return;
    const req = await db.prepare('SELECT * FROM tp_vendor_requests WHERE workspace_id = ? AND id = ?').get(workspaceId, requestId);
    const q = await db.prepare('SELECT submitted_at, vendor_question_count FROM tp_questionnaires WHERE workspace_id = ? AND id = ?').get(workspaceId, questionnaireId);
    if (!q || !q.submitted_at) return;
    const files = (await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_evidence WHERE workspace_id = ? AND assessment_id = ? AND source = 'vendor'`)
      .get(workspaceId, assessmentId)).n;
    const facts = { total: Number(q.vendor_question_count) || 0, files, submittedDay: b.f.day(q.submitted_at) };
    if (req) {
      await deliver(db, b, { kind: 'vendor_receipt', key: `vendor_receipt:${questionnaireId}`, role: 'third_party',
        to: { name: req.recipient_name, email: req.recipient_email }, data: { ...facts, contact: await contactFor(db, b, req.created_by) } });
    }
    for (const u of (await consultants(db, b, { linkCreator: req && req.created_by })).filter(reachable)) {
      await deliver(db, b, { kind: 'consultant_submitted', key: `consultant_submitted:${questionnaireId}:u${u.id}`, role: 'consultant',
        to: u, data: { ...facts, url: abs(`${assessmentPath(b)}?step=review`) } });
    }
  });
}

function clarificationAsked(db, { workspaceId, assessmentId, clarificationId }) {
  return safely('clarificationAsked', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return;
    const c = await db.prepare('SELECT * FROM tp_clarifications WHERE workspace_id = ? AND id = ?').get(workspaceId, clarificationId);
    if (!c || c.status !== 'open') return;
    const link = await db.prepare(`SELECT * FROM tp_vendor_requests WHERE workspace_id = ? AND questionnaire_id = ? AND status = 'active'
      AND expires_at > now() ORDER BY created_at DESC LIMIT 1`).get(workspaceId, c.questionnaire_id);
    if (!link) return;
    const sealed = sealedLink(link);
    await deliver(db, b, { kind: 'vendor_clarification', key: `vendor_clarification:${c.id}`, role: 'third_party',
      to: { name: link.recipient_name, email: link.recipient_email }, redactions: redactionsOf(sealed),
      data: { url: sealed ? sealed.url : null, questionId: c.question_id, body: c.body, sentDay: b.f.day(link.emailed_at || link.created_at), until: b.f.day(link.expires_at),
        contact: await contactFor(db, b, link.created_by) } });
  });
}

function clarificationAnswered(db, { workspaceId, assessmentId, clarificationId }) {
  return safely('clarificationAnswered', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return;
    const c = await db.prepare('SELECT * FROM tp_clarifications WHERE workspace_id = ? AND id = ?').get(workspaceId, clarificationId);
    if (!c || !c.responded_at) return;
    const answer = await db.prepare('SELECT id FROM tp_answers WHERE workspace_id = ? AND questionnaire_id = ? AND question_id = ?')
      .get(workspaceId, c.questionnaire_id, c.question_id);
    for (const u of (await consultants(db, b, { linkCreator: c.asked_by })).filter(reachable)) {
      await deliver(db, b, { kind: 'consultant_clarification_answered', key: `clarification_answered:${c.id}:u${u.id}`, role: 'consultant', to: u,
        data: { questionId: c.question_id, response: c.response, withFile: !!c.response_evidence_id,
          url: abs(`${assessmentPath(b)}?step=review&answers=all${answer ? `#answer-${answer.id}` : ''}`) } });
    }
  });
}

function recommendationIssued(db, { workspaceId, assessmentId, recommendationId }) {
  return safely('recommendationIssued', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return;
    const r = await db.prepare('SELECT * FROM tp_recommendations WHERE workspace_id = ? AND id = ?').get(workspaceId, recommendationId);
    const owner = await userRow(db, b.a.client_decision_owner_id);
    if (!r || r.status !== 'issued' || !reachable(owner)) return;
    await deliver(db, b, { kind: 'client_decision_needed', key: `client_decision_needed:${r.id}:u${owner.id}`, role: 'client', to: owner,
      data: { outcomeLabel: require('./recommendations').outcomeLabel(b.a.type, r.outcome), version: r.version, url: abs(portalRecPath(b, r.id)) } });
  });
}

function clientDecided(db, { workspaceId, assessmentId, decisionId }) {
  return safely('clientDecided', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return;
    const d = await db.prepare(`SELECT d.*, r.version, r.outcome AS recommended_outcome, u.name AS decider_name FROM tp_client_decisions d
      JOIN tp_recommendations r ON r.workspace_id = d.workspace_id AND r.id = d.recommendation_id
      LEFT JOIN users u ON u.id = d.decided_by WHERE d.workspace_id = ? AND d.id = ?`).get(workspaceId, decisionId);
    if (!d) return;
    const label = o => require('./recommendations').outcomeLabel(b.a.type, o) || (o === 'request_more_information' ? 'Need more information' : o);
    for (const u of (await consultants(db, b, { includeAuthor: true })).filter(reachable)) {
      await deliver(db, b, { kind: 'consultant_client_decided', key: `client_decided:${d.id}:u${u.id}`, role: 'consultant', to: u,
        data: { outcomeLabel: label(d.outcome), recommendedLabel: label(d.recommended_outcome), version: d.version, deciderName: d.decider_name,
          diverges: !!d.diverges, riskUntil: d.risk_acceptance_until ? b.f.day(d.risk_acceptance_until) : '', rationale: d.rationale,
          url: abs(`${assessmentPath(b)}?step=decision`) } });
    }
  });
}

async function issueLinkFor(db, workspaceId, assessmentId) {
  return await db.prepare(`SELECT * FROM tp_vendor_requests WHERE workspace_id = ? AND assessment_id = ? AND status IN ('active', 'submitted')
    AND expires_at > now() ORDER BY created_at DESC LIMIT 1`).get(workspaceId, assessmentId);
}

async function issueRecipient(db, b, workspaceId, assessmentId, issueId) {
  const link = await issueLinkFor(db, workspaceId, assessmentId);
  const sealed = link ? sealedLink(link) : null;
  const main = await db.prepare(`SELECT name, email FROM tp_vendor_people WHERE workspace_id = ? AND third_party_id = ? AND status = 'active' AND role = 'main'`)
    .get(workspaceId, b.a.third_party_id);
  const to = link ? { name: link.recipient_name, email: link.recipient_email } : main ? { name: main.name, email: main.email } : null;
  if (!to || !to.email) return null;
  return {
    to,
    url: sealed ? `${sealed.url}/issues#issue-${issueId}` : abs(`${require('./vendor-session').PORTAL_PATH}sign-in`),
    signIn: !sealed,
    redactions: redactionsOf(sealed),
    sentDay: link ? b.f.day(link.emailed_at || link.created_at) : '',
    until: link ? b.f.day(link.expires_at) : '',
    contact: await contactFor(db, b, link ? link.created_by : null),
  };
}

function issueShared(db, { workspaceId, assessmentId, issueId }) {
  return safely('issueShared', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return;
    const issue = await db.prepare('SELECT id, title, body, status, row_version FROM tp_issues WHERE workspace_id = ? AND id = ?').get(workspaceId, issueId);
    if (!issue || issue.status === 'withdrawn') return;
    const r = await issueRecipient(db, b, workspaceId, assessmentId, issue.id);
    if (!r) return { sent: false, reason: 'no_recipient' };
    await deliver(db, b, { kind: 'vendor_issue_shared', key: `vendor_issue_shared:${issue.id}:${issue.row_version}`, role: 'third_party',
      to: r.to, redactions: r.redactions,
      data: { url: r.url, signIn: r.signIn, issueTitle: issue.title, issueBody: issue.body, sentDay: r.sentDay, until: r.until, contact: r.contact } });
    return { sent: true };
  });
}

function issueFirmUpdate(db, { workspaceId, assessmentId, issueId, agreed = false }) {
  return safely('issueFirmUpdate', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return;
    const issue = await db.prepare(`SELECT id, title, status, agreed_fix, to_char(agreed_date, 'YYYY-MM-DD') AS agreed_date, row_version
      FROM tp_issues WHERE workspace_id = ? AND id = ?`).get(workspaceId, issueId);
    if (!issue || issue.status === 'withdrawn' || (agreed && issue.status !== 'agreed')) return;
    const m = agreed ? null : await db.prepare(`SELECT id, body FROM tp_issue_messages WHERE workspace_id = ? AND issue_id = ? AND author_kind = 'firm'
      ORDER BY id DESC LIMIT 1`).get(workspaceId, issueId);
    if (!agreed && !m) return;
    const r = await issueRecipient(db, b, workspaceId, assessmentId, issue.id);
    if (!r) return;
    await deliver(db, b, { kind: 'vendor_issue_update', key: agreed ? `vendor_issue_agreed:${issue.id}:${issue.row_version}` : `vendor_issue_reply:${m.id}`,
      role: 'third_party', to: r.to, redactions: r.redactions,
      data: { url: r.url, signIn: r.signIn, agreed, issueTitle: issue.title, body: m ? m.body : '', agreedFix: issue.agreed_fix, agreedDay: issue.agreed_date ? b.f.day(issue.agreed_date) : '',
        sentDay: r.sentDay, until: r.until, contact: r.contact } });
  });
}

async function portalEmail(db, kind, { workspaceId, to, data, key }) {
  return safely(kind, async () => {
    const ws = await db.prepare('SELECT id, firm_id, client_name, brand_display_name FROM workspaces WHERE id = ?').get(workspaceId);
    if (!ws) return null;
    const firm = await require('./vendor-portal').firmBrand(db, ws.firm_id);
    const m = lazyEmail().renderTprmEmail(kind, { ...data, toName: to.name, firmName: firm.name, clientName: ws.brand_display_name || ws.client_name,
      url: abs(require('./vendor-session').PORTAL_PATH + 'sign-in') });
    await lazyEmail().sendEmail({ to: to.email, subject: m.subject, html: m.html, firmId: ws.firm_id, workspaceId: ws.id, relatedType: `tprm:${kind}`,
      idempotencyKey: key });
    return { sent: true };
  });
}

async function signInCode(db, { email, code, firmId, firmName, minutes }) {
  return safely('signInCode', async () => {
    const m = lazyEmail().renderTprmEmail('vendor_sign_in_code', { code, firmName, minutes });
    await lazyEmail().sendEmail({ to: email, subject: m.subject, html: m.html, firmId, relatedType: 'tprm:vendor_sign_in_code', outboxRedactions: [code] });
    return { sent: true };
  });
}

function issueVendorReplied(db, { workspaceId, assessmentId, issueId }) {
  return safely('issueVendorReplied', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return;
    const issue = await db.prepare('SELECT id, title FROM tp_issues WHERE workspace_id = ? AND id = ?').get(workspaceId, issueId);
    const m = issue && await db.prepare(`SELECT id, body, proposed_fix, to_char(proposed_date, 'YYYY-MM-DD') AS proposed_date FROM tp_issue_messages
      WHERE workspace_id = ? AND issue_id = ? AND author_kind = 'third_party' ORDER BY id DESC LIMIT 1`).get(workspaceId, issueId);
    if (!m) return;
    for (const u of (await consultants(db, b, { includeAuthor: true })).filter(reachable)) {
      await deliver(db, b, { kind: 'consultant_issue_reply', key: `issue_reply:${m.id}:u${u.id}`, role: 'consultant', to: u,
        data: { issueTitle: issue.title, proposed: !!m.proposed_fix, proposedFix: m.proposed_fix, proposedDay: m.proposed_date ? b.f.day(m.proposed_date) : '',
          body: m.body, url: abs(`${assessmentPath(b)}?step=evidence#issue-${issue.id}`) } });
    }
  });
}

function proofSubmitted(db, { workspaceId, assessmentId, proofId, conditionId }) {
  return safely('proofSubmitted', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return;
    const c = await db.prepare('SELECT * FROM tp_conditions WHERE workspace_id = ? AND id = ?').get(workspaceId, conditionId);
    const p = await db.prepare('SELECT * FROM tp_condition_proofs WHERE workspace_id = ? AND id = ?').get(workspaceId, proofId);
    if (!c || !p) return;
    const files = (await db.prepare('SELECT COUNT(*)::int AS n FROM tp_condition_proof_files WHERE workspace_id = ? AND proof_id = ?').get(workspaceId, proofId)).n;
    for (const u of (await consultants(db, b, { includeAuthor: true })).filter(reachable)) {
      await deliver(db, b, { kind: 'consultant_proof_uploaded', key: `proof_uploaded:${p.id}:u${u.id}`, role: 'consultant', to: u,
        data: { position: c.position, conditionText: c.description, files, note: p.note, url: abs(`${assessmentPath(b)}?step=decision#conditions`) } });
    }
  });
}

async function conditionsLinkEmail(db, { workspaceId, assessmentId, link, url }) {
  const r = await safely('conditionsLinkEmail', async () => {
    const b = await base(db, workspaceId, assessmentId);
    if (!b) return { ok: false, error: 'The assessment was not found.' };
    const conds = await db.prepare(`SELECT description, due_date::text AS due_date FROM tp_conditions WHERE workspace_id = ? AND recommendation_id = ?
      AND owner = 'vendor' AND status IN ('open', 'changes_requested') ORDER BY position`).all(workspaceId, link.recommendation_id);
    const res = await deliver(db, b, { kind: 'conditions_link', key: `conditions_link:${link.id}`, role: 'third_party',
      to: { name: link.recipient_name, email: link.recipient_email }, redactions: [url, String(url).split('/').pop()],
      data: { url, until: b.f.day(link.expires_at), conditions: conds.map(c => ({ text: c.description, due: c.due_date ? b.f.day(c.due_date) : '' })),
        contact: await contactFor(db, b, link.created_by) } });
    return res && res.skipped === 'disabled' ? { ok: false, error: 'email delivery is switched off on this server' } : res;
  });
  return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'The email could not be sent.' };
}

async function answeredCount(db, workspaceId, questionnaireId) {
  return (await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_answers WHERE workspace_id = ? AND questionnaire_id = ? AND response IS NOT NULL`)
    .get(workspaceId, questionnaireId)).n;
}

function vendorReminderKind(link, now) {
  const exp = new Date(link.expires_at).getTime();
  const life = exp - new Date(link.created_at).getTime();
  const left = exp - now.getTime();
  if (left <= 0) return left > -OVERDUE_WINDOW_DAYS * DAY ? 'vendor_overdue' : null;
  if (left <= DAY) return life >= 2 * DAY ? 'vendor_reminder_1' : null;
  if (left <= 7 * DAY) return life >= 8 * DAY ? 'vendor_reminder_7' : null;
  return null;
}

async function reminders(db, { now = new Date() } = {}) {
  const at = now.toISOString();
  let sent = 0;
  const count = r => { if (r && r.ok) sent += 1; };
  const links = await db.prepare(`SELECT v.*, q.vendor_question_count FROM tp_vendor_requests v
    JOIN tp_questionnaires q ON q.workspace_id = v.workspace_id AND q.id = v.questionnaire_id
    JOIN tp_assessments a ON a.workspace_id = v.workspace_id AND a.id = v.assessment_id
    JOIN tp_client_settings cs ON cs.workspace_id = v.workspace_id AND cs.enabled AND cs.vendor_reminders
    WHERE v.status = 'active' AND q.status IN ('sent', 'in_progress') AND a.status NOT IN ('completed', 'cancelled')
      AND v.expires_at > ?::timestamptz - (? * interval '1 day') AND v.expires_at <= ?::timestamptz + interval '7 days'
    ORDER BY v.id`).all(at, OVERDUE_WINDOW_DAYS, at);
  for (const link of links) {
    const kind = vendorReminderKind(link, now);
    if (!kind) continue;
    await safely('reminders.vendor', async () => {
      const b = await base(db, link.workspace_id, link.assessment_id);
      if (!b) return;
      const sealed = kind === 'vendor_overdue' ? null : sealedLink(link, now);
      count(await deliver(db, b, { kind, key: `${kind}:${link.id}`, role: 'third_party', to: { name: link.recipient_name, email: link.recipient_email },
        redactions: redactionsOf(sealed),
        data: { url: sealed ? sealed.url : null, sentDay: b.f.day(link.emailed_at || link.created_at), until: b.f.day(link.expires_at), total: Number(link.vendor_question_count) || 0,
          answered: await answeredCount(db, link.workspace_id, link.questionnaire_id), contact: await contactFor(db, b, link.created_by) } }));
    });
  }

  const recs = await db.prepare(`SELECT r.id, r.workspace_id, r.assessment_id, r.issued_at, r.outcome, r.version FROM tp_recommendations r
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN tp_client_settings cs ON cs.workspace_id = r.workspace_id AND cs.enabled
    WHERE r.status = 'issued' AND a.status = 'recommendation_issued' AND a.client_decision_owner_id IS NOT NULL
      AND r.issued_at <= ?::timestamptz - (? * interval '1 day') AND r.issued_at > ?::timestamptz - (? * interval '1 day')
      AND NOT EXISTS (SELECT 1 FROM tp_client_decisions d WHERE d.workspace_id = r.workspace_id AND d.recommendation_id = r.id)
    ORDER BY r.id`).all(at, DECISION_REMINDER_DAYS, at, DECISION_REMINDER_WINDOW_DAYS);
  for (const r of recs) {
    await safely('reminders.decision', async () => {
      const b = await base(db, r.workspace_id, r.assessment_id);
      const owner = b && await userRow(db, b.a.client_decision_owner_id);
      if (!reachable(owner)) return;
      count(await deliver(db, b, { kind: 'client_decision_reminder', key: `client_decision_reminder:${r.id}:u${owner.id}`, role: 'client', to: owner,
        data: { outcomeLabel: require('./recommendations').outcomeLabel(b.a.type, r.outcome), issuedDay: b.f.day(r.issued_at), url: abs(portalRecPath(b, r.id)) } }));
    });
  }

  const conds = await db.prepare(`SELECT c.id, c.workspace_id, c.position, c.description, c.due_date::text AS due_date, c.recommendation_id, a.id AS assessment_id
    FROM tp_conditions c
    JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN tp_client_settings cs ON cs.workspace_id = c.workspace_id AND cs.enabled
    WHERE c.owner = 'client' AND c.status IN ('open', 'changes_requested') AND r.status = 'issued' AND a.status = 'completed'
      AND a.client_decision_owner_id IS NOT NULL
      AND c.due_date >= (?::timestamptz)::date AND c.due_date <= (?::timestamptz)::date + ?::integer
    ORDER BY c.id`).all(at, at, CONDITION_DUE_DAYS);
  for (const c of conds) {
    await safely('reminders.condition', async () => {
      const b = await base(db, c.workspace_id, c.assessment_id);
      const owner = b && await userRow(db, b.a.client_decision_owner_id);
      if (!reachable(owner)) return;
      count(await deliver(db, b, { kind: 'client_condition_due', key: `client_condition_due:${c.id}:${c.due_date}:u${owner.id}`, role: 'client', to: owner,
        data: { position: c.position, conditionText: c.description, dueDay: b.f.day(c.due_date), url: abs(portalRecPath(b, c.recommendation_id)) } }));
    });
  }
  return sent;
}

module.exports = {
  KIND_LABELS, ROLE_LABELS, OVERDUE_WINDOW_DAYS, DECISION_REMINDER_DAYS, CONDITION_DUE_DAYS,
  vendorReminderKind, sealedLink, deliver, vendorSubmitted, clarificationAsked, clarificationAnswered, recommendationIssued, clientDecided,
  proofSubmitted, conditionsLinkEmail, reminders, issueShared, issueFirmUpdate, issueVendorReplied, signInCode, portalEmail,
};
