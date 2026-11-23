'use strict';

const access = require('./access');
const isoLifecycle = require('../iso-lifecycle');
const { TprmError } = require('./errors');

const SWITCH_PERMISSION = 'tp.settings';

async function isEnabled(db, workspaceId) {
  const row = await db.prepare('SELECT enabled FROM tp_client_settings WHERE workspace_id=?').get(workspaceId);
  return !!(row && row.enabled);
}

async function enabledAmong(db, workspaceIds) {
  const ids = [...new Set((workspaceIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Set();
  const rows = await db.prepare(`SELECT workspace_id FROM tp_client_settings
    WHERE enabled AND workspace_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Set(rows.map(r => Number(r.workspace_id)));
}

async function setEnabled(db, workspaceId, enabled, actorId) {
  const on = !!enabled;
  await db.prepare(`INSERT INTO tp_client_settings (workspace_id, enabled, enabled_at, enabled_by)
    VALUES (?, ?, CASE WHEN ? THEN now() END, CASE WHEN ? THEN ?::bigint END)
    ON CONFLICT (workspace_id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      enabled_at = CASE WHEN EXCLUDED.enabled AND NOT tp_client_settings.enabled THEN now() ELSE tp_client_settings.enabled_at END,
      enabled_by = CASE WHEN EXCLUDED.enabled AND NOT tp_client_settings.enabled THEN EXCLUDED.enabled_by ELSE tp_client_settings.enabled_by END,
      updated_at = now(),
      row_version = tp_client_settings.row_version + CASE WHEN tp_client_settings.enabled IS DISTINCT FROM EXCLUDED.enabled THEN 1 ELSE 0 END`)
    .run(workspaceId, on, on, on, actorId || null);
}

async function enableOnCreate(db, workspaceId, actorId) {
  await setEnabled(db, workspaceId, true, actorId);
}

function requireSwitch(actor) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, SWITCH_PERMISSION)) {
    throw new TprmError(403, 'Only a manager can switch third-party risk on or off for a client.');
  }
}

async function thirdPartyCount(db, workspaceId) {
  return (await db.prepare('SELECT COUNT(*)::integer AS c FROM tp_third_parties WHERE workspace_id=?').get(workspaceId)).c;
}

async function switchOn(db, actor) {
  requireSwitch(actor);
  return await db.transaction(async () => {
    const was = await isEnabled(db, actor.ws.id);
    if (!was) await setEnabled(db, actor.ws.id, true, actor.user.id);
    return { changed: !was };
  })();
}

async function hasIsoProgramme(db, workspaceId) {
  const row = await db.prepare('SELECT frameworks FROM workspaces WHERE id=?').get(workspaceId);
  return !!row && isoLifecycle.hasIsoManagementSystem(row);
}

const NO_ISO_PROGRAMME = 'Third-party risk cannot be switched off for this client: it has no ISO programme, so it would be left with no service. Enable an ISO programme for the client first, or delete the client if the engagement has ended.';

async function switchOff(db, actor) {
  requireSwitch(actor);
  return await db.transaction(async () => {
    const row = await db.prepare('SELECT enabled FROM tp_client_settings WHERE workspace_id=? FOR UPDATE').get(actor.ws.id);
    if (!row || !row.enabled) return { changed: false };
    if (!(await hasIsoProgramme(db, actor.ws.id))) throw new TprmError(409, NO_ISO_PROGRAMME, { noIsoProgramme: true });
    const count = await thirdPartyCount(db, actor.ws.id);
    if (count > 0) {
      throw new TprmError(409, `Third-party risk cannot be switched off for this client: it has ${count} third part${count === 1 ? 'y' : 'ies'} recorded (exited ones included). Its register and history must stay available.`,
        { thirdParties: count });
    }
    await setEnabled(db, actor.ws.id, false, actor.user.id);
    return { changed: true };
  })();
}

module.exports = { SWITCH_PERMISSION, NO_ISO_PROGRAMME, isEnabled, enabledAmong, setEnabled, enableOnCreate, thirdPartyCount, hasIsoProgramme, switchOn, switchOff };
