'use strict';

const rbac = require('../rbac');

function isFirmUser(user) {
  return !!(user && user.user_type === 'firm');
}

function isClientUser(user) {
  return !!(user && user.user_type === 'client');
}

function firmCan(user, permission) {
  if (!isFirmUser(user) || rbac.CLIENT_ONLY_PERMISSIONS.has(permission)) return false;
  return rbac.hasPermission(new Set(rbac.rolePermissions(rbac.normalizeRole(user.firm_role) || 'consultant')), permission);
}

function isManager(user) {
  return isFirmUser(user) && rbac.isManager(rbac.normalizeRole(user.firm_role));
}

function can(user, perms, permission) {
  if (rbac.CLIENT_ONLY_PERMISSIONS.has(permission) && !isClientUser(user)) return false;
  return rbac.hasPermission(perms, permission);
}

async function loadFirmWorkspace(deps, user, workspaceId, { requireEnabled = true, permission = 'tp.view' } = {}) {
  if (!isFirmUser(user)) return null;
  const id = Number(workspaceId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const ws = await deps.getWorkspace(id, user);
  if (!ws || Number(ws.firm_id) !== Number(user.firm_id)) return null;
  const settings = await deps.db.prepare('SELECT enabled FROM tp_client_settings WHERE workspace_id=?').get(id);
  const enabled = !!(settings && settings.enabled);
  if (requireEnabled && !enabled) return null;
  const perms = await deps.permissionsFor(user, ws);
  if (!can(user, perms, permission)) return null;
  return { ws, perms, enabled };
}

async function listFirmClients(deps, user) {
  if (!isFirmUser(user)) return { enabled: [], available: [] };
  const visible = (await deps.listWorkspaces(user)).filter(w => Number(w.firm_id) === Number(user.firm_id));
  if (!visible.length) return { enabled: [], available: [] };
  const ids = visible.map(w => Number(w.id));
  const rows = await deps.db.prepare(`SELECT workspace_id, enabled_at FROM tp_client_settings
    WHERE enabled AND workspace_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const on = new Map(rows.map(r => [Number(r.workspace_id), r]));
  const enabled = [];
  const available = [];
  for (const w of visible) {
    const row = on.get(Number(w.id));
    const entry = { id: w.id, name: w.brand_display_name || w.client_name, sector: w.sector || null, enabledAt: row ? row.enabled_at : null };
    (row ? enabled : available).push(entry);
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  return { enabled: enabled.sort(byName), available: available.sort(byName) };
}

async function menuVisible(db, user, workspaces) {
  if (!isFirmUser(user) || !firmCan(user, 'tp.view')) return false;
  if ((rbac.normalizeRole(user.firm_role) || 'consultant') !== 'consultant') return true;
  const ids = (workspaces || []).filter(w => Number(w.firm_id) === Number(user.firm_id)).map(w => Number(w.id));
  if (!ids.length) return false;
  const row = await db.prepare(`SELECT 1 FROM tp_client_settings
    WHERE enabled AND workspace_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`).get(...ids);
  return !!row;
}

module.exports = { isFirmUser, isClientUser, isManager, firmCan, can, loadFirmWorkspace, listFirmClients, menuVisible };
