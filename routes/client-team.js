'use strict';

const { withToast, auditCtx } = require('../lib/http-helpers');
const clientTeam = require('../lib/client-team');
const notificationDelivery = require('../lib/notification-delivery');

const ISO = '/workspaces/:wsId/client-portal/account';
const TP = '/workspaces/:wsId/client-portal/third-party-risk/account';

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, logAction } = deps;

  const isoAccount = ws => `/workspaces/${ws.id}/client-portal/account`;
  const tpAccount = ws => `/workspaces/${ws.id}/client-portal/third-party-risk/account`;
  const notFound = (req, res) => res.status(404).render('error', {
    user: req.user, ws: req.workspace || null, message: 'This page does not exist, or it is not available to your account.',
  });
  const isClient = req => !!req.user && req.user.user_type === 'client';

  app.get(ISO, requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      if (!isClient(req)) return notFound(req, res);
      if (res.locals.tpOnlyClient === true) return res.redirect(tpAccount(req.workspace));
      const q = req.query || {};
      const message = typeof q.msg === 'string' && q.msg ? { text: q.msg.slice(0, 300), kind: q.msgKind === 'error' ? 'error' : 'ok' } : null;
      res.render('client_account', {
        user: req.user, ws: req.workspace, active: 'client-portal', portalView: 'account',
        team: await clientTeam.team(db, req.workspace),
        isOwner: clientTeam.isOwner(req.user, req.workspace),
        myRole: clientTeam.roleLabel(req.workspace.role),
        inviteRoles: clientTeam.INVITE_ROLES.map(r => ({ value: r, label: clientTeam.roleLabel(r) })),
        updates: await notificationDelivery.list(db, { workspaceId: req.workspace.id, actor: req.user, limit: 10 }),
        message,
      });
    } catch (err) { return next(err); }
  });

  function action(prefix, suffix, run) {
    app.post(prefix + suffix, requireAuth, requireWorkspace, async (req, res, next) => {
      try {
        if (!isClient(req)) return notFound(req, res);
        const tp = prefix === TP;
        if (tp && res.locals.tpPortalEnabled !== true) return notFound(req, res);
        const back = tp ? tpAccount(req.workspace) : isoAccount(req.workspace);
        const say = (text, kind) => res.redirect(tp
          ? withToast(back, text, kind)
          : `${back}?msg=${encodeURIComponent(text)}${kind === 'error' ? '&msgKind=error' : ''}`);
        if (!clientTeam.isOwner(req.user, req.workspace)) {
          return res.status(403).render('error', { user: req.user, ws: req.workspace, message: 'Only a client sponsor can change who is on your team.' });
        }
        try {
          return await run(req, say, res);
        } catch (err) {
          if (err instanceof clientTeam.TeamError && err.status === 404) return notFound(req, res);
          if (err instanceof clientTeam.TeamError) return say(err.message, 'error');
          throw err;
        }
      } catch (err) { return next(err); }
    });
  }

  app.post(`${TP}/email`, requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      if (!isClient(req) || res.locals.tpPortalEnabled !== true) return notFound(req, res);
      const on = (req.body || {}).value !== 'off';
      await clientTeam.setThirdPartyEmail(db, req.user.id, on);
      return res.redirect(withToast(tpAccount(req.workspace), on ? 'Third-party risk emails turned on' : 'Third-party risk emails turned off'));
    } catch (err) { return next(err); }
  });

  const unsent = email => `The invitation email to ${email} did not send. Try again with Resend.`;

  for (const prefix of [ISO, TP]) {
    action(prefix, '/team/invite', async (req, say) => {
      const r = await clientTeam.invite(db, req.workspace, req.user, req.body || {});
      await logAction(req.user.id, req.workspace.id, 'client_team_invite', 'user_invitation', r.id,
        { email: r.email, role: String((req.body || {}).role || ''), sent: r.sent }, auditCtx(req));
      const replaced = !r.replaced ? ''
        : r.replaced.role === r.role ? ` It replaces the earlier invitation as ${r.roleLabel}, whose link no longer works.`
        : ` It replaces the earlier invitation as ${r.replaced.roleLabel}, whose link no longer works: they now join as ${r.roleLabel}.`;
      return r.sent ? say(`Invitation sent to ${r.email}.${replaced} The link expires in 7 days.`) : say(`${unsent(r.email)}${replaced}`, 'error');
    });

    action(prefix, '/team/invites/:invId/resend', async (req, say) => {
      const r = await clientTeam.resend(db, req.workspace, req.user, req.params.invId);
      await logAction(req.user.id, req.workspace.id, 'client_team_invite_resent', 'user_invitation', r.id,
        { email: r.email, sent: r.sent }, auditCtx(req));
      return r.sent ? say(`Invitation sent again to ${r.email}. The earlier link no longer works.`) : say(unsent(r.email), 'error');
    });

    action(prefix, '/team/invites/:invId/revoke', async (req, say) => {
      const r = await clientTeam.revoke(db, req.workspace, req.user, req.params.invId);
      await logAction(req.user.id, req.workspace.id, 'client_team_invite_revoked', 'user_invitation', r.id, { email: r.email }, auditCtx(req));
      return say(`Invitation to ${r.email} withdrawn.`);
    });

    action(prefix, '/team/members/:userId/remove', async (req, say, res) => {
      if (prefix === ISO && (req.body || {}).confirmed !== '1') {
        const person = await clientTeam.removable(db, req.workspace, req.user, req.params.userId);
        return res.render('client_account_confirm', {
          user: req.user, ws: req.workspace, active: 'client-portal', portalView: 'account', person,
          action: `${isoAccount(req.workspace)}/team/members/${person.id}/remove`, back: isoAccount(req.workspace),
        });
      }
      const r = await clientTeam.remove(db, req.workspace, req.user, req.params.userId);
      await logAction(req.user.id, req.workspace.id, 'client_team_member_removed', 'user', r.id, { email: r.email, role: r.role }, auditCtx(req));
      return say(`${r.name || r.email} no longer has access to this client.`);
    });
  }
}

module.exports = { register };
