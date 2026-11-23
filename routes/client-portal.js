'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rbac = require('../lib/rbac');
const enc = require('../lib/encryption');
const documentHtml = require('../lib/document-html');
const evWrites = require('../lib/evidence-writes');
const docApprovals = require('../lib/doc-approvals');
const delivery = require('../lib/engagement-delivery');
const clientGapAssessment = require('../lib/client-gap-assessment');
const { buildIntegratedDashboard } = require('../lib/integrated-dashboard');
const uploadSecurity = require('../lib/upload-security');
const { requestPolicy, requestCapabilities, clientWorkPolicy } = require('../lib/client-request-policy');
const notifications = require('../lib/notification-delivery');
const { listWork } = require('../lib/work-projection');
const drafts = require('../lib/form-drafts');
const { withToast, auditCtx } = require('../lib/http-helpers');
const { todayFor } = require('../lib/dates');

const REQUEST_TYPES = new Set(['evidence', 'policy', 'control', 'action']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TERMINAL = new Set(['accepted', 'cancelled']);
const CLIENT_FILE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'rtf',
  'odt', 'ods', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip', 'json', 'xml'
]);
const MAX_TITLE = 180;
const MAX_DESCRIPTION = 12000;
const MAX_NOTE = 8000;
const MAX_COMMENT = 8000;

class UndeliverableShare extends Error {}

const clientStatus = value => ({
  draft: 'in preparation', workspace_verified: 'ready for approval', submitted: 'under review',
  changes_requested: 'changes requested', accepted: 'approved', rejected: 'not approved',
  superseded: 'replaced', open: 'open', in_progress: 'in progress', cancelled: 'cancelled'
}[String(value || '').toLowerCase()] || String(value || '').replace(/_/g, ' '));

const RESPONDER_TRANSITIONS = {
  open: new Set(['in_progress', 'submitted']),
  in_progress: new Set(['submitted']),
  changes_requested: new Set(['in_progress', 'submitted'])
};
const MANAGER_TRANSITIONS = {
  open: new Set(['in_progress', 'cancelled']),
  in_progress: new Set(['submitted', 'cancelled']),
  submitted: new Set(['accepted', 'changes_requested', 'cancelled']),
  changes_requested: new Set(['in_progress', 'cancelled']),
  accepted: new Set(['in_progress']),
  cancelled: new Set(['open'])
};

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          upload, resolveUploadPath, permissionsFor } = deps;

  function isContributor(req) {
    return req.user.user_type === 'client' &&
      require('../lib/rbac').normalizeRole(req.workspace._userRole || req.workspace.role) === 'contributor';
  }

  async function can(req, permission) {
    return require('../lib/rbac').hasPermission(await permissionsFor(req.user, req.workspace), permission);
  }

  function workspaceRole(req) {
    return rbac.normalizeRole(req.workspace._userRole || req.workspace.role);
  }

  async function allowFirmPermission(req, res, permission) {
    if (req.user.user_type === 'firm' && !(await can(req, permission))) {
      res.status(403).send('Forbidden');
      return false;
    }
    return true;
  }

  function requestVisibility(req, alias = 'cr', clientPreview = false) {
    if (isContributor(req)) return { clause: `${alias}.released_at IS NOT NULL AND ${alias}.assignee_id=?`, params: [req.user.id] };
    if (req.user.user_type === 'client' || clientPreview) {
      return { clause: `${alias}.released_at IS NOT NULL`, params: [] };
    }
    return { clause: '', params: [] };
  }

  function deliveryVisibleToActor(req, row, clientPreview = false) {
    const assignedToClient = row.owner_id != null || row.approver_id != null;
    if (req.user.user_type === 'firm') return clientPreview ? assignedToClient : true;
    if (isContributor(req)) {
      return row.owner_id === req.user.id || row.approver_id === req.user.id;
    }
    return assignedToClient;
  }

  function clientDownloadSourceAvailable(storedPath, firmId) {
    const token = String(storedPath || '');
    if (!token || path.basename(token) !== token) return false;
    try {
      const filePath = resolveUploadPath(token, firmId);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
      const uploadsRoot = fs.realpathSync(path.join(__dirname, '..', 'uploads'));
      const realFile = fs.realpathSync(filePath);
      return realFile !== uploadsRoot && realFile.startsWith(`${uploadsRoot}${path.sep}`);
    } catch (_) {
      return false;
    }
  }

  function clean(value, max) {
    const v = value == null ? '' : String(value).trim();
    return v.length > max ? null : v;
  }

  function validDate(value) {
    if (!value) return null;
    const v = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(v + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : false;
  }

  function badRequest(req, res, message) {
    return res.status(400).render('error', { user: req.user, ws: req.workspace, message });
  }

  async function requestFormFailure(req, res, errors) {
    const raw = req.body || {};
    return await renderClientPortal(req, res.status(422), {
      values: {
        request_type: String(raw.request_type || '').slice(0, 24),
        priority: String(raw.priority || '').slice(0, 24),
        assignee_id: String(raw.assignee_id || '').slice(0, 24),
        due_date: String(raw.due_date || '').slice(0, 32),
        control_id: String(raw.control_id || '').slice(0, 120),
        document_id: String(raw.document_id || '').slice(0, 24),
        title: String(raw.title || '').slice(0, MAX_TITLE),
        description: String(raw.description || '').slice(0, MAX_DESCRIPTION)
      },
      errors,
      hasErrors: true
    });
  }

  function decryptRequest(row, wsId) {
    if (!row) return row;
    return {
      ...row,
      description: enc.decryptIfNeeded(row.description, wsId),
      response_note: enc.decryptIfNeeded(row.response_note, wsId)
    };
  }

  async function loadRequest(req, id) {
    const visibility = requestVisibility(req);
    const row = await db.prepare(`SELECT cr.*, assignee.name AS assignee_name, assignee.email AS assignee_email,
        creator.name AS creator_name, reviewer.name AS reviewer_name, responder.name AS responder_name,
        i.title AS control_title, i.type AS control_type, d.name AS document_name,
        (SELECT COUNT(*) FROM client_request_evidence cre WHERE cre.request_id=cr.id) AS evidence_count,
        (SELECT COUNT(*) FROM comments c WHERE c.workspace_id=cr.workspace_id AND c.parent_type='client_request' AND c.parent_id=CAST(cr.id AS TEXT)) AS comment_count
      FROM client_requests cr
      LEFT JOIN users assignee ON assignee.id=cr.assignee_id
      LEFT JOIN users creator ON creator.id=cr.created_by
      LEFT JOIN users reviewer ON reviewer.id=cr.reviewed_by
      LEFT JOIN users responder ON responder.id=cr.responded_by
      LEFT JOIN iso_items i ON i.id=cr.control_id
      LEFT JOIN generated_docs d ON d.id=cr.document_id AND d.workspace_id=cr.workspace_id
      WHERE cr.id=? AND cr.workspace_id=?${visibility.clause ? ` AND ${visibility.clause}` : ''}`)
      .get(id, req.workspace.id, ...visibility.params);
    if (!row) return null;
    return decryptRequest(row, req.workspace.id);
  }

  async function insertEvent(req, requestId, eventType, fields = {}) {
    const note = fields.note == null ? null : enc.encryptIfNeeded(
      String(fields.note).slice(0, MAX_NOTE), req.workspace.id, !!req.workspace.encryption_enabled);
    const savedEvent = await db.prepare(`INSERT INTO client_request_events
      (request_id, workspace_id, actor_id, event_type, from_status, to_status, note, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      requestId, req.workspace.id, req.user.id, eventType,
      fields.fromStatus || null, fields.toStatus || null, note,
      fields.metadata ? JSON.stringify(fields.metadata) : null
    );
    const row = await db.prepare('SELECT * FROM client_requests WHERE id=? AND workspace_id=?').get(requestId,req.workspace.id);
    let notified = null;
    if (row && row.released_at && ['created','assigned','commented','status_changed','target_updated'].includes(eventType) && !fields.metadata?.internal) {
      const recipient = eventType === 'commented' ? (req.user.user_type === 'client' ? row.consultant_owner_id || row.created_by : row.assignee_id)
        : fields.toStatus === 'submitted' ? row.consultant_owner_id || row.created_by : row.assignee_id;
      const recipientIds = recipient ? [recipient] : (await clientMembers(req)).filter(m=>['client_owner','isms_manager'].includes(rbac.normalizeRole(m.role))).map(m=>m.id);
      const prefix = ({created:'New request',assigned:'Request assigned',commented:'New message',target_updated:'Request shared'})[eventType] || `Request ${clientStatus(fields.toStatus)}`;
      notified = await notifications.enqueue(db,{workspaceId:req.workspace.id,actorId:req.user.id,recipientIds,eventKey:`client_request_event:${savedEvent.lastInsertRowid}`,
        sourceType:'request',sourceId:requestId,title:`${prefix}: ${row.title}`,body:fields.note || null,
        link:`/workspaces/${req.workspace.id}/client-portal/requests/${requestId}`,severity:fields.toStatus==='changes_requested'?'warning':'info'});
    }
    return { eventId: Number(savedEvent.lastInsertRowid), notified };
  }

  async function notify(userId, req, title, body, link, severity = 'info', eventKey) {
    const source = notifications.sourceFromLink(link);
    if (!source || !userId || Number(userId) === Number(req.user.id)) return;
    const key = eventKey || `${source.sourceType}:${source.sourceId}:${title}:${crypto.createHash('sha256').update(String(body || '')).digest('hex')}`;
    await notifications.enqueue(db, { workspaceId:req.workspace.id, actorId:req.user.id, recipientIds:[userId],
      eventKey:key, sourceType:source.sourceType, sourceId:source.sourceId, title, body, link, severity });
  }

  async function policy(req, row) { return await requestPolicy({db,workspace:req.workspace,actor:req.user,row}); }
  async function creationAccess(req) { return (await requestCapabilities({db,workspace:req.workspace,actor:req.user})).canCreate; }
  async function requireCreation(req, res, next) {
    if (!(await creationAccess(req))) return res.status(403).send('You cannot create or release client requests.');
    next();
  }
  async function requireCoordinate(req, res, next) {
    const permission = req.user.user_type === 'firm' ? 'client_request.manage' : 'client_request.coordinate';
    if (!(await can(req,permission))) return res.status(403).render('error',{user:req.user,ws:req.workspace,message:'You cannot coordinate this request.'});
    next();
  }

  async function grantTargetScope(req, assigneeId, controlId, documentId) {
    if (!assigneeId) return;
    const member = await db.prepare(`SELECT wm.role, u.user_type FROM workspace_members wm
      INNER JOIN users u ON u.id=wm.user_id
      WHERE wm.workspace_id=? AND wm.user_id=? AND u.active=1`).get(req.workspace.id, assigneeId);
    if (!member || require('../lib/rbac').normalizeRole(member.role) !== 'contributor') return;
    const ins = db.prepare(`INSERT INTO member_scopes
      (workspace_id, user_id, scope_type, scope_id, granted_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
    if (controlId) await ins.run(req.workspace.id, assigneeId, 'control', controlId, req.user.id);
    if (documentId) await ins.run(req.workspace.id, assigneeId, 'document', String(documentId), req.user.id);
  }

  async function targetAccessible(req, scopeType, scopeId) {
    if (!isContributor(req)) return true;
    const scoped = await db.prepare(`SELECT 1 FROM member_scopes
      WHERE workspace_id=? AND user_id=? AND scope_type=? AND scope_id=?`).get(
      req.workspace.id, req.user.id, scopeType, String(scopeId));
    if (scoped) return true;
    const column = scopeType === 'control' ? 'control_id' : 'document_id';
    return !!(await db.prepare(`SELECT 1 FROM client_requests
      WHERE workspace_id=? AND assignee_id=? AND ${column}=? AND status!='cancelled'`).get(
      req.workspace.id, req.user.id, scopeId));
  }

  async function clientPolicyAccessible(req, document) {
    if (req.user.user_type === 'firm') return true;
    if (document.current_version_id && (await db.prepare('SELECT 1 FROM doc_approvers WHERE workspace_id=? AND document_id=? AND version_id=? AND user_id=?').get(req.workspace.id,document.id,document.current_version_id,req.user.id))) return true;
    if (isContributor(req)) return await targetAccessible(req, 'document', document.id);
    if (!['client_owner', 'isms_manager'].includes(workspaceRole(req))) return false;

    const sharedRequest = await db.prepare(`SELECT 1 FROM client_requests
      WHERE workspace_id=? AND document_id=? AND released_at IS NOT NULL AND status!='cancelled'
      LIMIT 1`).get(req.workspace.id, document.id);
    if (sharedRequest) return true;
    if (!document.current_version_id) return false;
    return !!(await db.prepare(`SELECT 1 FROM doc_approvers
      WHERE workspace_id=? AND document_id=? AND version_id=? AND user_id=?
      LIMIT 1`).get(req.workspace.id, document.id, document.current_version_id, req.user.id));
  }

  async function loadVisiblePolicy(req, documentId) {
    const document = await db.prepare(`SELECT d.*, u.name AS creator_name
      FROM generated_docs d LEFT JOIN users u ON u.id=d.created_by
      WHERE d.id=? AND d.workspace_id=?`).get(documentId, req.workspace.id);
    return document && (await clientPolicyAccessible(req, document)) ? document : null;
  }

  async function clientMembers(req) {
    return await db.prepare(`SELECT u.id, u.name, u.email, wm.role
      FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
      WHERE wm.workspace_id=? AND u.active=1 AND u.user_type='client'
      ORDER BY CASE wm.role WHEN 'client_owner' THEN 1 WHEN 'isms_manager' THEN 2 ELSE 3 END, u.name`).all(req.workspace.id);
  }

  async function controlCatalog() {
    return await db.prepare(`SELECT id, type, title FROM iso_items
      WHERE type IN ('clause','control') ORDER BY sort_order NULLS FIRST`).all();
  }

  async function documentCatalog(req) {
    return await db.prepare(`SELECT id, name, status, version FROM generated_docs
      WHERE workspace_id=? AND status NOT IN ('retired','withdrawn') ORDER BY name`).all(req.workspace.id);
  }

  async function renderClientPortal(req, res, suppliedRequestForm = null) {
      const allowedPortalViews = new Set(['home', 'actions', 'progress']);
      const portalView = suppliedRequestForm
        ? 'actions'
        : (allowedPortalViews.has(String(req.query.view || '')) ? String(req.query.view) : 'home');
      const requestForm = suppliedRequestForm || { values: {}, errors: {}, hasErrors: false };
      const clientPreview = req.user.user_type === 'firm' && req.query.preview === 'client';
      const members = await clientMembers(req);
      const clientPreviewUser = clientPreview
        ? (members.find(member => member.role === 'client_owner') || members[0] || null)
        : null;
      const portalActorId = clientPreviewUser?.id || req.user.id;
      const clientAudience = req.user.user_type === 'client' || clientPreview;
      const filters = [];
      const params = [req.workspace.id];
      const visibility = requestVisibility(req, 'cr', clientPreview);
      if (visibility.clause) filters.push(visibility.clause);
      params.push(...visibility.params);
      const status = String(req.query.status || 'active');
      if (status === 'active') filters.push("cr.status NOT IN ('accepted','cancelled')");
      else if (status === 'closed') filters.push("cr.status IN ('accepted','cancelled')");
      else if (['open','in_progress','submitted','changes_requested'].includes(status)) {
        filters.push('cr.status=?'); params.push(status);
      }
      const where = filters.length ? ' AND ' + filters.join(' AND ') : '';
      const requests = (await db.prepare(`SELECT cr.*, a.name AS assignee_name, c.name AS creator_name,
          i.title AS control_title, d.name AS document_name,
          (SELECT COUNT(*) FROM client_request_evidence cre WHERE cre.request_id=cr.id) AS evidence_count,
          (SELECT COUNT(*) FROM comments cm WHERE cm.workspace_id=cr.workspace_id AND cm.parent_type='client_request' AND cm.parent_id=CAST(cr.id AS TEXT) ${clientAudience?'AND cm.internal_only=0':''}) AS comment_count
        FROM client_requests cr
        LEFT JOIN users a ON a.id=cr.assignee_id
        LEFT JOIN users c ON c.id=cr.created_by
        LEFT JOIN iso_items i ON i.id=cr.control_id
        LEFT JOIN generated_docs d ON d.id=cr.document_id AND d.workspace_id=cr.workspace_id
        WHERE cr.workspace_id=?${where}
        ORDER BY CASE cr.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                 CASE WHEN cr.due_date IS NULL THEN 1 ELSE 0 END, cr.due_date, cr.created_at DESC`).all(...params))
        .map(r => decryptRequest(r, req.workspace.id));

      const allVisible = await db.prepare(`SELECT status, due_date FROM client_requests cr
        WHERE cr.workspace_id=?${visibility.clause ? ` AND ${visibility.clause}` : ''}`) // nosemgrep: javascript.express.security.injection.tainted-sql-string.tainted-sql-string
        .all(req.workspace.id, ...visibility.params);
      const today = todayFor(req.workspace);
      const requestMetrics = {
        active: allVisible.filter(r => !TERMINAL.has(r.status)).length,
        overdue: allVisible.filter(r => ['open','in_progress','changes_requested'].includes(r.status) &&
          r.due_date && r.due_date < today).length,
        awaitingReview: allVisible.filter(r => r.status === 'submitted').length,
        completed: allVisible.filter(r => r.status === 'accepted').length
      };

      const pendingApprovals = await db.prepare(`SELECT d.id AS document_id, d.name, d.status, dv.version,
          da.sequence, da.role_label, da.notified_at
        FROM doc_approvers da
        INNER JOIN generated_docs d ON d.id=da.document_id AND d.workspace_id=da.workspace_id
        INNER JOIN doc_versions dv ON dv.id=da.version_id
        WHERE da.workspace_id=? AND da.user_id=? AND da.decision IS NULL
          AND d.current_version_id=da.version_id
        ORDER BY da.sequence, d.name`).all(req.workspace.id, portalActorId);

      const visibleRequestIds = requests.map(r => r.id);
      let recentEvents = [];
      if (visibleRequestIds.length) {
        const marks = visibleRequestIds.map(() => '?').join(',');
        recentEvents = (await db.prepare(`SELECT e.*, u.name AS actor_name, cr.title AS request_title
          FROM client_request_events e INNER JOIN users u ON u.id=e.actor_id
          INNER JOIN client_requests cr ON cr.id=e.request_id
          WHERE e.request_id IN (${marks}) ORDER BY e.created_at DESC, e.id DESC LIMIT 12`).all(...visibleRequestIds))
          .map(e => ({ ...e, note: enc.decryptIfNeeded(e.note, req.workspace.id) }));
      }

      const workspaceFrameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
      const deliveryProjection = workspaceFrameworks.includes('iso27001')
        ? await delivery.getProjection(db, req.workspace, portalActorId, { ensure: false })
        : null;
      let deliveryWork = [];
      if (deliveryProjection) {
        deliveryWork = deliveryProjection.deliverables.filter(d => d.client_visible &&
          deliveryVisibleToActor(req, d, clientPreview));
      }
      const deliveryEvidence = deliveryWork.length ? await db.prepare(`SELECT de.deliverable_id,e.id,e.filename,e.uploaded_at
        FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id
        WHERE de.workspace_id=? AND de.deliverable_id IN (${deliveryWork.map(() => '?').join(',')}) ORDER BY de.id DESC`)
        .all(req.workspace.id, ...deliveryWork.map(d => d.id)) : [];
      const deliveryComments = (await db.prepare(`SELECT c.*,u.name user_name FROM comments c JOIN users u ON u.id=c.user_id
        WHERE c.workspace_id=? AND c.parent_type='engagement_deliverable' AND c.internal_only=0 ORDER BY c.id`).all(req.workspace.id))
        .map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));

      const consultantContactRaw = (await db.prepare(`SELECT u.id,u.name,u.email
        FROM users u
        WHERE u.id=? AND u.user_type='firm' AND u.active=1`).get(req.workspace.lead_consultant_id)) ||
        (await db.prepare(`SELECT u.id,u.name,u.email
          FROM workspace_members wm JOIN users u ON u.id=wm.user_id
          WHERE wm.workspace_id=? AND u.user_type='firm' AND u.active=1
          ORDER BY CASE wm.role WHEN 'firm_owner' THEN 1 WHEN 'senior_consultant' THEN 2 ELSE 3 END,u.id LIMIT 1`).get(req.workspace.id)) || null;
      const consultantContact = consultantContactRaw ? {
        ...consultantContactRaw,
        display_name: /^(admin|administrator)$/i.test(String(consultantContactRaw.name || '').trim())
          ? 'Engagement team' : consultantContactRaw.name,
        display_email: /@example\.(com|org|net)$/i.test(String(consultantContactRaw.email || ''))
          ? null : consultantContactRaw.email
      } : null;
      const acceptedDelivery = deliveryWork.filter(d => d.status === 'accepted').length;
      const pendingDelivery = deliveryWork
        .filter(d => !['accepted','superseded'].includes(d.status))
        .sort((a,b) => String(a.due_date || '9999-12-31').localeCompare(String(b.due_date || '9999-12-31')))[0] || null;
      const deliverySummary = {
        total: deliveryWork.length,
        accepted: acceptedDelivery,
        progressPct: deliveryWork.length ? Math.round(acceptedDelivery / deliveryWork.length * 100) : 0,
        currentPhase: deliveryProjection?.currentPhase?.name || 'Engagement planning',
        targetDate: deliveryProjection?.plan?.target_completion_date || req.workspace.target_cert_date || null,
        nextTitle: pendingDelivery?.client_title || null,
        nextDue: pendingDelivery?.due_date || null
      };
      const clientMemberIds = new Set(members.map(member => member.id));
      const isClientDeliveryAction = d => {
        const effectiveStatus = d.effective_status || d.status;
        if (isContributor(req)) {
          return (d.owner_id === portalActorId && ['draft','changes_requested'].includes(d.status)) ||
            (d.approver_id === portalActorId && ['submitted','workspace_verified'].includes(effectiveStatus));
        }
        if (clientAudience) {
          return (clientMemberIds.has(d.owner_id) && ['draft','changes_requested'].includes(d.status)) ||
            (clientMemberIds.has(d.approver_id) && ['submitted','workspace_verified'].includes(effectiveStatus));
        }
        return (d.owner_id === portalActorId && ['draft','changes_requested'].includes(d.status)) ||
          (d.approver_id === portalActorId && ['submitted','workspace_verified'].includes(effectiveStatus));
      };
      const clientDeliveryActions = deliveryWork.filter(d =>
        isClientDeliveryAction(d));
      const overdueDeliverables = clientDeliveryActions.filter(d =>
        d.due_date && d.due_date < today && !['accepted','superseded'].includes(d.status)).length;
      const awaitingReviewDeliverables = deliveryWork.filter(d => {
        const effectiveStatus = d.effective_status || d.status;
        if (!['submitted','workspace_verified'].includes(effectiveStatus)) return false;
        if (isContributor(req)) return d.owner_id === portalActorId && !clientMemberIds.has(d.approver_id);
        if (clientAudience) return clientMemberIds.has(d.owner_id) && !clientMemberIds.has(d.approver_id);
        return d.owner_id === portalActorId;
      }).length;
      const metrics = {
        activeRequests: allVisible.filter(r => ['open', 'in_progress', 'changes_requested'].includes(r.status)).length,
        deliverablesToProvide: clientDeliveryActions.filter(d =>
          clientMemberIds.has(d.owner_id) && ['draft','changes_requested'].includes(d.status)).length,
        overdue: requestMetrics.overdue + overdueDeliverables,
        awaitingReview: requestMetrics.awaitingReview + awaitingReviewDeliverables,
        overdueRequests: requestMetrics.overdue,
        overdueDeliverables,
        awaitingReviewRequests: requestMetrics.awaitingReview,
        awaitingReviewDeliverables
      };
      metrics.allZero = metrics.activeRequests === 0 && metrics.deliverablesToProvide === 0 &&
        metrics.overdue === 0 && metrics.awaitingReview === 0;
      const gapAssessment = await clientGapAssessment.buildClientGapAssessmentProjection(db, req.workspace, {
        assigneeId: isContributor(req) ? req.user.id : null,
        releasedOnly: clientAudience && !isContributor(req)
      });
      let frameworkWorkspace = req.workspace;
      if (!Array.isArray(frameworkWorkspace.frameworks)) {
        let parsed = [];
        try { parsed = JSON.parse(frameworkWorkspace.frameworks || '[]'); } catch (_) {}
        frameworkWorkspace = { ...frameworkWorkspace, frameworks: parsed };
      }
      const programmeTruth = await buildIntegratedDashboard(db, frameworkWorkspace, {
        actorId: isContributor(req) ? portalActorId : null,
        clientFacing: clientAudience,
        today
      });
      metrics.overdue = programmeTruth.client.overdueCount;
      metrics.awaitingReview = programmeTruth.client.awaitingReviewCount;
      metrics.allZero = metrics.activeRequests === 0 && metrics.deliverablesToProvide === 0 &&
        metrics.overdue === 0 && metrics.awaitingReview === 0;
      const clientProgrammes = programmeTruth.programmes.map(programme => ({
        key: programme.key,
        label: programme.label,
        short: programme.short,
        descriptor: programme.descriptor,
        status: programme.status,
        completionPct: programme.completionPct,
        assessmentDetail: programme.assessmentDetail,
        currentLabel: programme.currentLabel,
        currentDetail: programme.currentDetail,
        openItems: programme.openItems,
        unassessedOutcomes: programme.unassessedOutcomes,
        openConfirmedFindings: programme.openConfirmedFindings,
        unsupportedImplemented: programme.unsupportedImplemented || 0
      }));
      const workScope = isContributor(req) ? 'mine' : req.query.work_scope === 'mine' ? 'mine' : 'client';
      const legacyFilter = ({submitted:'waiting',closed:'complete',open:'action_required',in_progress:'action_required',changes_requested:'action_required'})[status];
      const workFilter = ['action_required','blocked','waiting','complete','all'].includes(req.query.work_status) ? req.query.work_status : legacyFilter || 'open';
      const work = await listWork({db,workspaces:[req.workspace],actor:clientPreview ? (clientPreviewUser ? {...clientPreviewUser,user_type:'client'} : {id:-1}) : req.user,
        scope:clientAudience ? workScope : 'team',today,filters:{status:workFilter,programme:req.query.programme || null,q:req.query.q || ''},cursor:req.query.cursor,limit:50});
      if (clientAudience) { metrics.awaitingReview=work.counts.waiting;metrics.overdue=work.counts.overdue; }
      const actionCount = clientAudience ? work.counts.actionRequired : programmeTruth.client.actionCount + pendingApprovals.length;
      const blockerCount = clientAudience ? work.counts.blocked || 0 : programmeTruth.client.blockerCount +
        (gapAssessment.applicable ? gapAssessment.blockers.filter(blocker => blocker.source === 'fieldwork').length : 0);
      const statusTone = blockerCount ? 'risk' : actionCount ? 'attention' : 'good';
      const clientStatusSummary = {
        tone: statusTone,
        label: statusTone === 'risk' ? 'Needs attention' : statusTone === 'attention' ? 'In progress' : 'On track',
        actionCount,
        blockerCount,
        message: statusTone === 'risk'
          ? `${blockerCount} blocker${blockerCount === 1 ? ' needs' : 's need'} attention.`
          : actionCount
            ? `${actionCount} item${actionCount === 1 ? ' needs' : 's need'} action from your team.`
            : 'There is nothing your team needs to do right now.'
      };

      return res.render((await require('../lib/experience-flags').enabledFor(db,{actor:req.user,workspace:req.workspace}))?'client_portal':'client_portal_legacy', {
        user: req.user, ws: req.workspace, active: 'client-portal', title: 'Client portal',
        requests, metrics, pendingApprovals, recentEvents, status,
        canManage: clientPreview ? false : ((await can(req, 'client_request.coordinate')) || (req.user.user_type === 'firm' && (await can(req, 'client_request.manage')))), members,
        clientPreview, clientPreviewUser, canCreate: !clientPreview && (await creationAccess(req)),
        controls: (await creationAccess(req)) ? await controlCatalog() : [],
        documents: (await creationAccess(req)) ? await documentCatalog(req) : [],
        deliveryPlan: deliveryProjection?.plan || null, deliveryWork, deliveryEvidence, deliveryComments,
        consultantContact, deliverySummary, clientDeliveryActions, gapAssessment,
        portalView, clientProgrammes, clientStatusSummary, requestForm, work,workScope,workFilter,workQuery:String(req.query.q || '')
      });
  }

  app.get('/workspaces/:wsId/client-portal', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), async (req, res) => await renderClientPortal(req, res));

  app.get('/workspaces/:wsId/client-portal/updates',requireAuth,requireWorkspace,requirePermission('client_portal.view'),async (req, res) => {
    const unreadOnly = req.query.filter !== 'all';
    const updates = await notifications.list(db,{workspaceId:req.workspace.id,actor:req.user,unreadOnly,limit:200});
    res.render('client_updates',{user:req.user,ws:req.workspace,active:'client-portal',portalView:'updates',updates,unreadOnly});
  });
  app.post('/workspaces/:wsId/client-portal/updates/:id/:action(read|dismiss)',requireAuth,requireWorkspace,requirePermission('client_portal.view'),async (req, res) => {
    if (!(await notifications.mark(db,{workspaceId:req.workspace.id,actor:req.user,notificationId:req.params.id,action:req.params.action}))) return res.status(404).send('Update not found.');
    res.redirect(`/workspaces/${req.workspace.id}/client-portal/updates`);
  });
  app.post('/workspaces/:wsId/client-portal/updates/read-all',requireAuth,requireWorkspace,requirePermission('client_portal.view'),async (req, res) => {
    await notifications.markAllRead(db,{workspaceId:req.workspace.id,actor:req.user});
    res.redirect(`/workspaces/${req.workspace.id}/client-portal/updates`);
  });

  app.post('/workspaces/:wsId/client-portal/requests/:id/release',requireAuth,requireWorkspace,requireCreation,async (req, res) => {
    if (req.user.user_type !== 'firm') return res.status(403).send('Only the consultancy can share requests.');
    const row = await loadRequest(req,req.params.id);
    if (!row) return res.status(404).send('Request not found.');
    let result;
    try {
      result = await db.transaction(async () => {
        const result = await db.prepare(`UPDATE client_requests SET released_at=COALESCE(released_at,utc_now_text()),released_by=COALESCE(released_by,?),version=version+1
          WHERE workspace_id=? AND id=? AND version=?`).run(req.user.id,req.workspace.id,row.id,Number(req.body.version));
        if (result.changes) {
          const shared = await insertEvent(req,row.id,'target_updated',{note:'Shared with the client team.'});
          if (!shared.notified || !shared.notified.length) throw new UndeliverableShare();
        }
        return result;
      })();
    } catch (error) {
      if (!(error instanceof UndeliverableShare)) throw error;
      return res.status(422).send(row.assignee_id
        ? 'Not shared. The person this request is assigned to can no longer receive it, so nobody on the client team would be told. Reassign it to an active client team member, then share it again.'
        : 'Not shared. This request has no assignee and this client team has no owner or ISMS manager to pick it up, so nobody would be told or able to open it. Assign it to an active client team member, then share it again.');
    }
    if (!result.changes) return res.status(409).send('This request changed. Reload before sharing it.');
    await logAction(req.user.id,req.workspace.id,'release_client_request','client_request',row.id,null,auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/requests/${row.id}`,'Request shared with the client team.'));
  });

  async function loadVisibleDelivery(req, id) {
    const frameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
    if (!frameworks.includes('iso27001')) return null;
    if (!(await delivery.isDeliverableInOutcomeScope(db, req.workspace, id))) return null;
    const row = await db.prepare(`SELECT d.*,m.title milestone_title,p.name phase_name,m.source_rule
      FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
      JOIN engagement_delivery_phases p ON p.id=m.phase_id WHERE d.id=? AND d.workspace_id=? AND d.client_visible=1`).get(id, req.workspace.id);
    if (!row) return null;
    return deliveryVisibleToActor(req, row) ? row : null;
  }

  async function deliveryPolicy(req, row) {
    const projected = (await delivery.getProjection(db,req.workspace,req.user.id,{ensure:false}))?.deliverables.find(item=>Number(item.id)===Number(row.id));
    return clientWorkPolicy({db,workspace:req.workspace,actor:req.user,sourceType:'deliverable',row:{...row,effective_status:projected?.effective_status || row.status}});
  }

  async function renderDeliveryDetail(req, res, options={}) {
    const item = await loadVisibleDelivery(req,req.params.id);
    if (!item) return res.status(404).render('error',{user:req.user,ws:req.workspace,message:'This deliverable is unavailable or is not assigned to you.'});
    const evidence = await db.prepare(`SELECT e.id,e.filename,e.description,e.uploaded_at,u.name uploader FROM engagement_delivery_evidence de
      JOIN evidence e ON e.id=de.evidence_id AND e.workspace_id=de.workspace_id LEFT JOIN users u ON u.id=e.uploaded_by
      WHERE de.workspace_id=? AND de.deliverable_id=? ORDER BY de.id DESC`).all(req.workspace.id,item.id);
    const comments = (await db.prepare(`SELECT c.*,u.name user_name FROM comments c JOIN users u ON u.id=c.user_id
      WHERE c.workspace_id=? AND c.parent_type='engagement_deliverable' AND c.parent_id=? AND c.internal_only=0 ORDER BY c.id`).all(req.workspace.id,String(item.id)))
      .map(row=>({...row,body:enc.decryptIfNeeded(row.body,req.workspace.id)}));
    const events = await db.prepare(`SELECT e.action,e.from_status,e.to_status,e.created_at,u.name actor_name FROM engagement_delivery_events e
      LEFT JOIN users u ON u.id=e.actor_id WHERE e.workspace_id=? AND e.entity_type='deliverable' AND e.entity_id=? ORDER BY e.id`).all(req.workspace.id,item.id);
    const owner = item.owner_id ? await db.prepare('SELECT name FROM users WHERE id=?').get(item.owner_id) : null;
    const approver = item.approver_id ? await db.prepare('SELECT name FROM users WHERE id=?').get(item.approver_id) : null;
    res.status(options.status||200).render('client_deliverable_detail',{user:req.user,ws:req.workspace,item,evidence,comments,events,owner,approver,policy:await deliveryPolicy(req,item),portalView:'actions',decisionError:options.error||null,decisionNote:options.note||'',commentBody:options.body||''});
  }
  app.get('/workspaces/:wsId/client-portal/deliverables/:id(\\d+)',requireAuth,requireWorkspace,requirePermission('client_portal.view'),async (req, res) => await renderDeliveryDetail(req,res));

  async function deliveryDecision(req, res, action) {
    let effectiveBody=req.body;
    try {
      const result=await drafts.commit(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'deliverable-decision',recordId:String(req.params.id),contextKey:'',encryptionEnabled:!!req.workspace.encryption_enabled},req.body,async input => {
        effectiveBody=input;
        const row=await loadVisibleDelivery(req,req.params.id);
        if(!row)throw drafts.failure('This item is unavailable or is not assigned to you.',400);
        if(!(await deliveryPolicy(req,row)).commands.includes(action))throw drafts.failure(action==='submit'?'Only the assigned owner or client coordinator can submit this deliverable.':'Only the assigned approver can make this decision.',403);
        const expected=input.expected_record_version ?? input.row_version;
        if(expected!=null&&Number(expected)!==Number(row.row_version))throw drafts.failure('This deliverable changed. Compare the latest information with your note before deciding.');
        const note=clean(input.note,MAX_NOTE);
        if(note===null)throw drafts.failure(`The note must be under ${MAX_NOTE} characters.`,422);
        if(action==='submit'&&row.requires_evidence&&!(await db.prepare('SELECT 1 FROM engagement_delivery_evidence WHERE workspace_id=? AND deliverable_id=? LIMIT 1').get(req.workspace.id,row.id)))throw drafts.failure('Upload and link at least one evidence file before submitting this deliverable.',400);
        await delivery.transitionDeliverable(db,req.workspace,req.user.id,row.id,action,note);
        await logAction(req.user.id,req.workspace.id,`client_${action}_delivery_deliverable`,'engagement_deliverable',row.id,{note},auditCtx(req));
        await notify(action==='submit'?row.approver_id:row.owner_id,req,`Deliverable ${action==='submit'?'awaiting approval':action==='accept'?'approved':'returned for changes'}: ${row.client_title||row.title}`,note,`/workspaces/${req.workspace.id}/client-portal/deliverables/${row.id}`,action==='changes'?'warning':'info',`deliverable:${row.id}:${row.row_version}:${action}`);
        return {url:withToast(`/workspaces/${req.workspace.id}/client-portal/deliverables/${row.id}`,action==='submit'?'Sent for approval.':'Your response has been saved.')};
      });
      return res.redirect(result.url);
    }catch(error){
      const item=await loadVisibleDelivery(req,req.params.id);
      if(!item)return res.status(error.status||400).render('error',{user:req.user,ws:req.workspace,message:error.message});
      return await renderDeliveryDetail(req,res,{status:error.status||400,error:error.message,note:effectiveBody.note});
    }
  }
  ['submit','accept','changes','reject'].forEach(action=>app.post(`/workspaces/:wsId/client-portal/deliverables/:id/${action}`,requireAuth,requireWorkspace,requirePermission('client_request.respond'),async (req, res) => await deliveryDecision(req,res,action)));

  app.post('/workspaces/:wsId/client-portal/deliverables/:id/comments',requireAuth,requireWorkspace,requirePermission('client_request.respond'),async (req, res) => {
    let effectiveBody=req.body;
    try {
      const result=await drafts.commit(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'deliverable-comment',recordId:String(req.params.id),contextKey:'',encryptionEnabled:!!req.workspace.encryption_enabled},req.body,async input => {
        effectiveBody=input;
        const row=await loadVisibleDelivery(req,req.params.id),body=clean(input.body,MAX_COMMENT);
        if(!row || !body) throw drafts.failure('A visible deliverable and comment are required.',400);
        if(input.expected_record_version!=null && Number(input.expected_record_version)!==Number(row.row_version)) throw drafts.failure('This deliverable changed. Review it before posting your saved comment.');
        const comment=await db.prepare(`INSERT INTO comments(workspace_id,parent_type,parent_id,user_id,body,internal_only) VALUES (?,'engagement_deliverable',?,?,?,0)`)
          .run(req.workspace.id,String(row.id),req.user.id,enc.encryptIfNeeded(body,req.workspace.id,!!req.workspace.encryption_enabled));
        await delivery.event(db,req.workspace.id,row.plan_id,req.user.id,'deliverable',row.id,'client_commented',null,null,null);
        await notify(row.owner_id===req.user.id?row.approver_id:row.owner_id,req,'Delivery comment: '+(row.client_title || row.title),body.slice(0,180),`/workspaces/${req.workspace.id}/client-portal/deliverables/${row.id}`,'info',`delivery_comment:${comment.lastInsertRowid}`);
        await logAction(req.user.id,req.workspace.id,'client_comment_delivery_deliverable','engagement_deliverable',row.id,null,auditCtx(req));
        return {url:`/workspaces/${req.workspace.id}/client-portal/deliverables/${row.id}#discussion`};
      });
      res.redirect(result.url);
    } catch(error) { if(!(await loadVisibleDelivery(req,req.params.id)))return res.status(error.status||400).render('error',{user:req.user,ws:req.workspace,message:error.message}); return await renderDeliveryDetail(req,res,{status:error.status||400,error:error.message,body:effectiveBody.body}); }
  });

  app.post('/workspaces/:wsId/client-portal/deliverables/:id/evidence', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), upload.single('file'), async (req, res) => {
      const cleanup = () => { try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (_) {} };
      const row = await loadVisibleDelivery(req, req.params.id);
      if (!row || !req.file) { cleanup(); return badRequest(req, res, !row ? 'This item is unavailable or is not assigned to you.' : 'Choose a file to upload.'); }
      if (['accepted','superseded','rejected'].includes(row.status)) { cleanup(); return badRequest(req,res,'This deliverable is closed to new evidence. Ask the engagement team to reopen it.'); }
      if (row.owner_id && row.owner_id !== req.user.id && !((await can(req, 'client_request.coordinate')) || (req.user.user_type === 'firm' && (await can(req,'client_request.manage'))))) { cleanup(); return badRequest(req, res, 'Only the assigned owner can add evidence.'); }
      const inspection = uploadSecurity.validateUpload(req.file, CLIENT_FILE_EXTENSIONS);
      if (!inspection.ok) { cleanup(); await logAction(req.user.id, req.workspace.id, 'reject_client_upload', 'engagement_deliverable', row.id, { filename: req.file.originalname, reason: inspection.message }, auditCtx(req)); return badRequest(req, res, inspection.message); }
      const sha = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
      let evidenceId;
      await db.transaction(async () => {
        const existing = await db.prepare(`SELECT id FROM evidence WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
        if (existing) { evidenceId = existing.id; cleanup(); }
        else evidenceId = (await db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description,tags) VALUES (?,?,?,?,?,?,?,?)`)
          .run(req.workspace.id, req.file.originalname, req.file.filename, sha, req.file.size, req.user.id, row.title, `client-portal, engagement-deliverable-${row.id}`)).lastInsertRowid;
        await db.prepare(`INSERT INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`).run(req.workspace.id, row.id, evidenceId, req.user.id);
        await delivery.event(db, req.workspace.id, row.plan_id, req.user.id, 'deliverable', row.id, 'client_evidence_linked', null, null, { evidenceId, sha });
      })();
      await logAction(req.user.id, req.workspace.id, 'client_upload_delivery_evidence', 'engagement_deliverable', row.id, { evidence_id: evidenceId }, auditCtx(req));
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/deliverables/${row.id}`, 'File added. Submit when all supporting information is ready.'));
    });

  app.get('/workspaces/:wsId/client-portal/deliverables/:id/evidence/:evidenceId/download', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), async (req, res) => {
      if (!(await allowFirmPermission(req, res, 'evidence.download'))) return;
      const deliverable = await loadVisibleDelivery(req, req.params.id);
      if (!deliverable) return res.status(404).send('Not found');
      const row = await db.prepare(`SELECT e.* FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id
        WHERE de.deliverable_id=? AND de.evidence_id=? AND de.workspace_id=? AND e.workspace_id=?`).get(deliverable.id, req.params.evidenceId, req.workspace.id, req.workspace.id);
      if (!row) return res.status(404).send('Not found');
      const filePath = resolveUploadPath(row.stored_path, req.workspace.firm_id);
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File missing');
      await logAction(req.user.id, req.workspace.id, 'client_download_delivery_evidence', 'evidence', row.id, { deliverable_id: deliverable.id }, auditCtx(req));
      res.download(filePath, row.filename);
    });

  app.post('/workspaces/:wsId/client-portal/requests', requireAuth, requireWorkspace,
    requireCreation, async (req, res) => {
      if (req.user.user_type !== 'firm') return res.status(403).send('Only the consultancy can create client requests.');
      const type = String(req.body.request_type || '');
      const priority = String(req.body.priority || 'normal');
      const title = clean(req.body.title, MAX_TITLE);
      const description = clean(req.body.description, MAX_DESCRIPTION);
      const dueDate = validDate(req.body.due_date);
      const assigneeId = req.body.assignee_id ? parseInt(req.body.assignee_id, 10) : null;
      const controlId = req.body.control_id ? String(req.body.control_id) : null;
      const documentId = req.body.document_id ? parseInt(req.body.document_id, 10) : null;
      const errors = {};
      if (!REQUEST_TYPES.has(type)) errors.request_type = 'Choose a valid request type.';
      if (!PRIORITIES.has(priority)) errors.priority = 'Choose a valid priority.';
      if (!title || title === null) errors.title = `Enter a title of ${MAX_TITLE} characters or fewer.`;
      if (description === null) errors.description = `Keep the context to ${MAX_DESCRIPTION} characters or fewer.`;
      if (dueDate === false) errors.due_date = 'Enter a valid calendar date.';
      if (req.body.assignee_id && (!Number.isInteger(assigneeId) || assigneeId <= 0)) {
        errors.assignee_id = 'Choose an assignee from this workspace.';
      }
      if (req.body.document_id && (!Number.isInteger(documentId) || documentId <= 0)) {
        errors.document_id = 'Choose a policy from this workspace.';
      }
      if (type === 'control' && !controlId) errors.control_id = 'Choose the control or clause this request concerns.';
      if (type === 'policy' && !documentId) errors.document_id = 'Choose the policy this request concerns.';
      if (!errors.assignee_id && assigneeId && !(await db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
          WHERE wm.workspace_id=? AND wm.user_id=? AND u.active=1 AND u.user_type='client'`).get(req.workspace.id, assigneeId))) {
        errors.assignee_id = 'Choose an active client member of this workspace.';
      }
      if (controlId && !(await db.prepare(`SELECT 1 FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(controlId))) {
        errors.control_id = 'Choose a control or clause from the list.';
      }
      if (!errors.document_id && documentId && !(await db.prepare(`SELECT 1 FROM generated_docs
          WHERE id=? AND workspace_id=? AND status NOT IN ('retired','withdrawn')`).get(documentId, req.workspace.id))) {
        errors.document_id = 'Choose an active policy from this workspace.';
      }
      if (Object.keys(errors).length) return await requestFormFailure(req, res, errors);

      let id;
      await db.transaction(async () => {
        id = (await db.prepare(`INSERT INTO client_requests
          (workspace_id, request_type, title, description, priority, assignee_id, control_id, document_id, due_date, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          req.workspace.id, type, title,
          enc.encryptIfNeeded(description || null, req.workspace.id, !!req.workspace.encryption_enabled),
          priority, assigneeId, controlId, documentId, dueDate || null, req.user.id
        )).lastInsertRowid;
        await insertEvent(req, id, 'created', { metadata: { type, priority, assignee_id: assigneeId, control_id: controlId, document_id: documentId, due_date: dueDate || null } });
        await grantTargetScope(req, assigneeId, controlId, documentId);
      })();
      await logAction(req.user.id, req.workspace.id, 'create_client_request', 'client_request', id,
        { type, priority, assignee_id: assigneeId, control_id: controlId, document_id: documentId, due_date: dueDate || null }, auditCtx(req));
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/requests/${id}`, 'Client request created'));
    });

  async function renderRequestDetail(req, res, options={}) {
      const request = await loadRequest(req, req.params.id);
      if (!request) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Request not found or not assigned to you.' });
      const evidence = await db.prepare(`SELECT e.*, u.name AS uploader, cre.linked_at
        FROM client_request_evidence cre INNER JOIN evidence e ON e.id=cre.evidence_id
        LEFT JOIN users u ON u.id=e.uploaded_by
        WHERE cre.request_id=? AND e.workspace_id=? ORDER BY cre.linked_at DESC`).all(request.id, req.workspace.id);
      const comments = (await db.prepare(`SELECT c.*, u.name AS user_name FROM comments c
        INNER JOIN users u ON u.id=c.user_id
        WHERE c.workspace_id=? AND c.parent_type='client_request' AND c.parent_id=?
          ${req.user.user_type === 'client' ? 'AND c.internal_only=0' : ''}
        ORDER BY c.created_at, c.id`).all(req.workspace.id, String(request.id)))
        .map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
      const events = (await db.prepare(`SELECT e.*, u.name AS actor_name FROM client_request_events e
        INNER JOIN users u ON u.id=e.actor_id WHERE e.request_id=? AND e.workspace_id=?
          ${req.user.user_type === 'client' ? "AND NOT(CASE WHEN e.event_type='commented' THEN COALESCE(e.metadata::jsonb->>'internal','0') ELSE '0' END IN ('true','1'))" : ''}
        ORDER BY e.created_at, e.id`).all(request.id, req.workspace.id))
        .map(e => ({ ...e, note: enc.decryptIfNeeded(e.note, req.workspace.id) }));
      const requestPolicy = await policy(req,request);
      const allowedTransitions = requestPolicy.commands;
      res.status(options.status || 200).render('client_request_detail', {
        formError:options.error || null,responseValues:options.values || {},
        user: req.user, ws: req.workspace, active: 'client-portal', title: request.title,
        request, evidence, comments, events, allowedTransitions,
        canManage: requestPolicy.canCoordinate, canCreate: await creationAccess(req),
        canRespond: requestPolicy.canRespond,
        members: await clientMembers(req)
      });
  }
  async function requestFailure(req, res, message, status=400, values=req.body || {}) {
    if (req.get('accept')?.includes('application/json')) return res.status(status).json({ok:false,error:message});
    return await renderRequestDetail(req,res,{error:message,status,values});
  }
  app.get('/workspaces/:wsId/client-portal/requests/:id',requireAuth,requireWorkspace,requirePermission('client_portal.view'),async (req, res) => await renderRequestDetail(req,res));

  app.post('/workspaces/:wsId/client-portal/requests/:id/transition', requireAuth, requireWorkspace, async (req, res) => {
      let effectiveBody=req.body;
      try {
        const result = await drafts.commit(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'client-response',recordId:String(req.params.id),contextKey:'',encryptionEnabled:!!req.workspace.encryption_enabled},req.body,async body => {
          effectiveBody=body;
          const request = await loadRequest(req,req.params.id);
          if (!request) throw drafts.failure('Request not found or not assigned to you.',404);
          const target = String(body.status || '');
          if (!(await policy(req,request)).commands.includes(target)) throw drafts.failure('You cannot make this decision in the current request state.',403);
          const version = Number(body.expected_record_version ?? body.version);
          if (!Number.isInteger(version) || version!==Number(request.version)) throw drafts.failure('This request changed in another session. Your note is preserved below; review the latest request before applying your decision.');
          const note = clean(body.response_note,MAX_NOTE);
          if (note===null) throw drafts.failure(`Response notes must be under ${MAX_NOTE} characters.`,400);
          if (target==='changes_requested' && !note) throw drafts.failure('Explain the changes required before sending the request back.',400);
          if (target==='submitted' && ['evidence','control'].includes(request.request_type) && !Number(request.evidence_count)) throw drafts.failure('Attach at least one supporting file before submitting this request for review.',400);
          const evidenceQuality = String(req.user.user_type==='firm' ? body.evidence_quality || request.evidence_quality || 'not_reviewed' : request.evidence_quality || 'not_reviewed');
          if (!['not_reviewed','insufficient','partially_sufficient','sufficient'].includes(evidenceQuality)) throw drafts.failure('Choose a valid evidence-quality conclusion.',400);
          const encryptedNote = enc.encryptIfNeeded(note || request.response_note || null,req.workspace.id,!!req.workspace.encryption_enabled);
          const update = await db.prepare(`UPDATE client_requests SET status=?,response_note=?,reviewed_by=?,evidence_quality=?,
            submitted_at=CASE WHEN ?='submitted' THEN utc_now_text() ELSE submitted_at END,
            closed_at=CASE WHEN ? IN ('accepted','cancelled') THEN utc_now_text() ELSE NULL END,
            responded_by=CASE WHEN ?='submitted' THEN ? ELSE responded_by END,
            responded_for=CASE WHEN ?='submitted' THEN assignee_id ELSE responded_for END,updated_at=utc_now_text(),version=version+1
            WHERE id=? AND workspace_id=? AND version=?`).run(target,encryptedNote,req.user.user_type==='firm' && ['accepted','changes_requested'].includes(target)?req.user.id:request.reviewed_by,evidenceQuality,
              target,target,target,req.user.id,target,request.id,req.workspace.id,version);
          if (!update.changes) throw drafts.failure('This request changed. Review the latest version before continuing.');
          await insertEvent(req,request.id,'status_changed',{fromStatus:request.status,toStatus:target,note:note || null,metadata:{responded_by:req.user.id,responded_for:target==='submitted'?request.assignee_id:null}});
          await logAction(req.user.id,req.workspace.id,'transition_client_request','client_request',request.id,{from:request.status,to:target,responded_by:req.user.id,responded_for:request.assignee_id},auditCtx(req));
          return {url:`/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`,status:target};
        });
        res.redirect(withToast(result.url,`Request is now ${clientStatus(result.status)}`));
      } catch(error) { return await requestFailure(req,res,error.message,error.status || 400,effectiveBody); }
    });

  app.post('/workspaces/:wsId/client-portal/requests/:id/assign', requireAuth, requireWorkspace,
    requireCoordinate, async (req, res) => {
      const request = await loadRequest(req, req.params.id);
      if (!request) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Request not found.' });
      const assigneeId = req.body.assignee_id ? parseInt(req.body.assignee_id, 10) : null;
      if (assigneeId && !(await db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
        WHERE wm.workspace_id=? AND wm.user_id=? AND u.active=1 AND u.user_type='client'`).get(req.workspace.id, assigneeId))) {
        return await requestFailure(req, res, 'The assignee is not an active client member of this workspace.');
      }
      const version = parseInt(req.body.version, 10);
      const result = await db.transaction(async () => {
        const result = await db.prepare(`UPDATE client_requests SET assignee_id=?, updated_at=utc_now_text(), version=version+1
          WHERE id=? AND workspace_id=? AND version=?`).run(assigneeId, request.id, req.workspace.id, version);
        if (result.changes) {
          await grantTargetScope(req, assigneeId, request.control_id, request.document_id);
          await insertEvent(req, request.id, 'assigned', { metadata: { from: request.assignee_id, to: assigneeId } });
        }
        return result;
      })();
      if (!result.changes) return await requestFailure(req,res,'This request changed in another session. Review the current assignee before reassigning.',409);
      await logAction(req.user.id, req.workspace.id, 'assign_client_request', 'client_request', request.id,
        { from: request.assignee_id, to: assigneeId }, auditCtx(req));
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`, 'Assignee updated'));
    });

  app.post('/workspaces/:wsId/client-portal/requests/:id/comments', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), async (req, res) => {
      let effectiveBody=req.body;
      try {
        const result=await drafts.commit(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'client-comment',recordId:String(req.params.id),contextKey:'',encryptionEnabled:!!req.workspace.encryption_enabled},req.body,async input => {
          effectiveBody=input;
          const request=await loadRequest(req,req.params.id);
          if(!request) throw drafts.failure('Request not found or not assigned to you.',404);
          if(input.expected_record_version!=null && Number(input.expected_record_version)!==Number(request.version)) throw drafts.failure('This request changed while you wrote your comment. Review the latest request and try again.');
          const body=clean(input.body,MAX_COMMENT);
          if(!body) throw drafts.failure(`Comment is required and must be under ${MAX_COMMENT} characters.`,400);
          const internal=input.internal_only==='1' && req.user.user_type==='firm'?1:0;
          await db.prepare(`INSERT INTO comments(workspace_id,parent_type,parent_id,user_id,body,internal_only) VALUES (?,'client_request',?,?,?,?)`)
            .run(req.workspace.id,String(request.id),req.user.id,enc.encryptIfNeeded(body,req.workspace.id,!!req.workspace.encryption_enabled),internal);
          await insertEvent(req,request.id,'commented',{note:internal?'Internal comment added':body.slice(0,500),metadata:{internal:!!internal}});
          await logAction(req.user.id,req.workspace.id,'comment_client_request','client_request',request.id,{internal:!!internal},auditCtx(req));
          return {url:`/workspaces/${req.workspace.id}/client-portal/requests/${request.id}#discussion`};
        });
        res.redirect(result.url);
      } catch(error) { return await requestFailure(req,res,error.message,error.status || 400,effectiveBody); }
    });

  app.post('/workspaces/:wsId/client-portal/requests/:id/evidence', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), upload.single('file'), async (req, res) => {
      const cleanup = () => { try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {} };
      const request = await loadRequest(req, req.params.id);
      if (!request) { cleanup(); return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Request not found or not assigned to you.' }); }
      if (!req.file) return await requestFailure(req, res, 'Choose a file to upload.');
      if (TERMINAL.has(request.status)) { cleanup(); return await requestFailure(req, res, 'Closed requests cannot receive new evidence. Reopen the request first.'); }
      const managing = (await policy(req,request)).canCoordinate;
      if (!managing && request.assignee_id !== req.user.id) { cleanup(); return res.status(403).render('error', { user: req.user, ws: req.workspace, message: 'Only the assignee can upload evidence to this request.' }); }
      const inspection = uploadSecurity.validateUpload(req.file, CLIENT_FILE_EXTENSIONS);
      if (!inspection.ok) { cleanup(); await logAction(req.user.id, req.workspace.id, 'reject_client_upload', 'client_request', request.id, { filename: req.file.originalname, reason: inspection.message }, auditCtx(req)); return await requestFailure(req, res, inspection.message); }
      const description = clean(req.body.description, 2000);
      if (description === null) { cleanup(); return await requestFailure(req, res, 'Evidence description must be under 2,000 characters.'); }
      const sha = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
      let evidenceId;
      let deduped = false;
      try {
      await db.transaction(async () => {
        const existing = await db.prepare(`SELECT id FROM evidence WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL
          ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
        if (existing) {
          evidenceId = existing.id;
          deduped = true;
          cleanup();
        } else {
          evidenceId = (await db.prepare(`INSERT INTO evidence
            (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            req.workspace.id, request.control_id || null, req.file.originalname, req.file.filename,
            sha, req.file.size, req.user.id, description || request.title,
            `client-portal, request-${request.id}`
          )).lastInsertRowid;
        }
        await db.prepare(`INSERT INTO client_request_evidence (request_id, evidence_id, linked_by)
          VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(request.id, evidenceId, req.user.id);
        if (request.control_id) await evWrites.attachIsoControl(db, evidenceId, request.control_id, null);
        const updated = await db.prepare(`UPDATE client_requests SET updated_at=utc_now_text(),version=version+1 WHERE id=? AND workspace_id=? AND version=?`).run(request.id,req.workspace.id,request.version);
        if (!updated.changes) throw drafts.failure('This request changed while the file was uploading. Review the latest request and upload again.');
        await db.prepare(`UPDATE form_drafts SET base_version=?,draft_version=draft_version+1,last_save_id=NULL,saved_at=to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          WHERE workspace_id=? AND actor_id=? AND kind='client-response' AND record_id=? AND context_key='' AND state='active' AND base_version=?`)
          .run(String(Number(request.version)+1),req.workspace.id,req.user.id,String(request.id),String(request.version));
        await insertEvent(req, request.id, 'evidence_linked', { metadata: { evidence_id: evidenceId, filename: req.file.originalname, sha256: sha, deduped } });
      })();
      } catch(error) { cleanup(); return await requestFailure(req,res,error.message,error.status || 400); }
      await logAction(req.user.id, req.workspace.id, deduped ? 'link_existing_evidence_to_client_request' : 'upload_client_request_evidence',
        'client_request', request.id, { evidence_id: evidenceId, filename: req.file.originalname, sha256: sha }, auditCtx(req));
      if (req.get('accept')?.includes('application/json')) {
        const file=await db.prepare(`SELECT e.id,e.filename,e.description,cre.linked_at FROM evidence e JOIN client_request_evidence cre ON cre.evidence_id=e.id WHERE e.id=? AND cre.request_id=?`).get(evidenceId,request.id);
        return res.json({ok:true,message:deduped?'Existing evidence linked':'Evidence uploaded',requestVersion:Number(request.version)+1,
          evidence:{...file,uploader:req.user.name,downloadUrl:`/workspaces/${req.workspace.id}/client-portal/requests/${request.id}/evidence/${file.id}/download`},
          draft:await drafts.get(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'client-response',recordId:String(request.id),contextKey:''})});
      }
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`, deduped ? 'Existing evidence linked' : 'Evidence uploaded'));
    });

  app.get('/workspaces/:wsId/client-portal/requests/:id/evidence/:evidenceId/download', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), async (req, res) => {
      if (!(await allowFirmPermission(req, res, 'evidence.download'))) return;
      const request = await loadRequest(req, req.params.id);
      if (!request) return res.status(404).send('Not found');
      const evidence = await db.prepare(`SELECT e.* FROM client_request_evidence cre
        INNER JOIN evidence e ON e.id=cre.evidence_id
        WHERE cre.request_id=? AND cre.evidence_id=? AND e.workspace_id=?`).get(request.id, req.params.evidenceId, req.workspace.id);
      if (!evidence) return res.status(404).send('Not found');
      const fp = resolveUploadPath(evidence.stored_path, req.workspace.firm_id);
      if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
      await logAction(req.user.id, req.workspace.id, 'download_client_request_evidence', 'evidence', evidence.id,
        { request_id: request.id }, auditCtx(req));
      res.download(fp, evidence.filename);
    });

  app.get('/workspaces/:wsId/client-portal/controls/:isoId', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), async (req, res) => {
      const isoId = String(req.params.isoId);
      if (!(await targetAccessible(req, 'control', isoId))) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Control not found or not assigned to you.' });
      const item = await db.prepare(`SELECT * FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(isoId);
      if (!item) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Control not found.' });
      const state = (await db.prepare(`SELECT * FROM v_control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, isoId)) || {};
      const comments = (await db.prepare(`SELECT c.*, u.name AS user_name FROM comments c INNER JOIN users u ON u.id=c.user_id
        WHERE c.workspace_id=? AND c.parent_type='iso_item' AND c.parent_id=?
          ${req.user.user_type === 'client' ? 'AND c.internal_only=0' : ''}
        ORDER BY c.created_at, c.id`).all(req.workspace.id, isoId))
        .map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
      const evidence = await db.prepare(`SELECT DISTINCT e.id, e.filename, e.description, e.uploaded_at, e.sha256, u.name AS uploader
        FROM evidence e INNER JOIN evidence_requirement_links erl ON erl.evidence_id=e.id
        INNER JOIN requirements rq ON rq.id=erl.requirement_id INNER JOIN frameworks f ON f.id=rq.framework_id
        LEFT JOIN users u ON u.id=e.uploaded_by
        WHERE e.workspace_id=? AND f.code='iso27001' AND rq.ref=? AND e.superseded_at IS NULL
        ORDER BY e.uploaded_at DESC NULLS LAST`).all(req.workspace.id, isoId);
      res.render('client_portal_control', { user: req.user, ws: req.workspace, active: 'client-portal', title: item.title, item, state, comments, evidence });
    });

  app.post('/workspaces/:wsId/client-portal/controls/:isoId/comments', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), async (req, res) => {
      const isoId = String(req.params.isoId);
      if (!(await targetAccessible(req, 'control', isoId))) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Control not found or not assigned to you.' });
      if (!(await db.prepare(`SELECT 1 FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(isoId))) return res.status(404).send('Not found');
      const body = clean(req.body.body, MAX_COMMENT);
      if (!body || body === null) return badRequest(req, res, `Comment is required and must be under ${MAX_COMMENT} characters.`);
      const internal = req.body.internal_only === '1' && req.user.user_type === 'firm' ? 1 : 0;
      await db.prepare(`INSERT INTO comments (workspace_id, parent_type, parent_id, user_id, body, internal_only)
        VALUES (?, 'iso_item', ?, ?, ?, ?)`).run(req.workspace.id, isoId, req.user.id,
        enc.encryptIfNeeded(body, req.workspace.id, !!req.workspace.encryption_enabled), internal);
      await logAction(req.user.id, req.workspace.id, 'client_portal_control_comment', 'control', isoId, { internal: !!internal }, auditCtx(req));
      res.redirect(`/workspaces/${req.workspace.id}/client-portal/controls/${encodeURIComponent(isoId)}#discussion`);
    });

  app.get('/workspaces/:wsId/client-portal/policies/:id', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), async (req, res) => {
      if (!(await allowFirmPermission(req, res, 'document.view'))) return;
      const documentId = parseInt(req.params.id, 10);
      const raw = await loadVisiblePolicy(req, documentId);
      if (!raw) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Policy not found.' });
      return await require('../lib/client-policy-view').render(db,req,res,raw);
    });

  app.post('/workspaces/:wsId/client-portal/policies/:id/comments', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), async (req, res) => {
      if (!(await allowFirmPermission(req, res, 'document.view'))) return;
      const documentId = parseInt(req.params.id, 10);
      if (!(await loadVisiblePolicy(req, documentId))) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Policy not found or not assigned to you.' });
      const body = clean(req.body.body, MAX_COMMENT);
      if (!body || body === null) return badRequest(req, res, `Comment is required and must be under ${MAX_COMMENT} characters.`);
      const internal = req.body.internal_only === '1' && req.user.user_type === 'firm' ? 1 : 0;
      await db.prepare(`INSERT INTO comments (workspace_id, parent_type, parent_id, user_id, body, internal_only)
        VALUES (?, 'document', ?, ?, ?, ?)`).run(req.workspace.id, String(documentId), req.user.id,
        enc.encryptIfNeeded(body, req.workspace.id, !!req.workspace.encryption_enabled), internal);
      await logAction(req.user.id, req.workspace.id, 'client_portal_policy_comment', 'document', documentId, { internal: !!internal }, auditCtx(req));
      res.redirect(`/workspaces/${req.workspace.id}/client-portal/policies/${documentId}#discussion`);
    });
}

module.exports = { register, REQUEST_TYPES, PRIORITIES, RESPONDER_TRANSITIONS, MANAGER_TRANSITIONS };
