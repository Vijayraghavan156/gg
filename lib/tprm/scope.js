'use strict';

const access = require('./access');
const rbac = require('../rbac');
const { TprmError } = require('./errors');

const SETTINGS_PERMISSION = 'tp.settings';

async function ownOnly(db, firmId) {
  if (!firmId) return false;
  const row = await db.prepare('SELECT consultants_own_only FROM tp_firm_settings WHERE firm_id = ?').get(Number(firmId));
  return !!(row && row.consultants_own_only);
}

function scopedRole(user) {
  return access.isFirmUser(user) && rbac.normalizeRole(user.firm_role) === 'consultant';
}

async function restricted(db, user) {
  return scopedRole(user) && await ownOnly(db, user.firm_id);
}

function predicate(alias, userId) {
  const t = alias;
  const id = Number(userId);
  return {
    sql: `(${t}.team_owner_id = ? OR ${t}.team_reviewer_id = ? OR ${t}.created_by = ?
      OR EXISTS (SELECT 1 FROM tp_assessments sa WHERE sa.workspace_id = ${t}.workspace_id AND sa.third_party_id = ${t}.id
        AND (sa.lead_consultant_id = ? OR sa.reviewer_id = ? OR sa.created_by = ? OR sa.proposed_by = ?))
      OR EXISTS (SELECT 1 FROM tp_recommendations sr JOIN tp_assessments sb ON sb.workspace_id = sr.workspace_id AND sb.id = sr.assessment_id
        WHERE sb.workspace_id = ${t}.workspace_id AND sb.third_party_id = ${t}.id AND sr.author_id = ?))`,
    params: [id, id, id, id, id, id, id, id],
  };
}

async function filterFor(db, user, alias) {
  if (!(await restricted(db, user))) return { sql: '', params: [] };
  const p = predicate(alias, user.id);
  return { sql: ` AND ${p.sql}`, params: p.params };
}

async function canSee(db, user, workspaceId, thirdPartyId) {
  if (!(await restricted(db, user))) return true;
  const p = predicate('t', user.id);
  const row = await db.prepare(`SELECT 1 FROM tp_third_parties t WHERE t.workspace_id = ? AND t.id = ? AND ${p.sql}`)
    .get(Number(workspaceId), Number(thirdPartyId), ...p.params);
  return !!row;
}

async function visibleIds(db, user, workspaceIds) {
  if (!(await restricted(db, user)) || !workspaceIds.length) return null;
  const p = predicate('t', user.id);
  const rows = await db.prepare(`SELECT t.id FROM tp_third_parties t WHERE t.workspace_id IN (${workspaceIds.map(() => '?').join(',')}) AND ${p.sql}`)
    .all(...workspaceIds.map(Number), ...p.params);
  return new Set(rows.map(r => Number(r.id)));
}

async function keep(db, user, rows, { tp = 'third_party_id', ws = 'workspace_id' } = {}) {
  if (!rows.length || !(await restricted(db, user))) return rows;
  const vis = await visibleIds(db, user, [...new Set(rows.map(r => Number(r[ws])))]);
  return rows.filter(r => vis.has(Number(r[tp])));
}

async function setOwnOnly(db, user, input = {}) {
  if (!access.isFirmUser(user) || !user.firm_id || !access.firmCan(user, SETTINGS_PERMISSION)) {
    throw new TprmError(403, 'Only a manager can change who sees which third parties.');
  }
  const want = String(input.consultants_own_only || '') === '1';
  return await db.transaction(async () => {
    await db.prepare('INSERT INTO tp_firm_settings (firm_id) VALUES (?) ON CONFLICT (firm_id) DO NOTHING').run(Number(user.firm_id));
    const row = await db.prepare('SELECT consultants_own_only FROM tp_firm_settings WHERE firm_id = ? FOR UPDATE').get(Number(user.firm_id));
    if (!!row.consultants_own_only === want) return { changed: false, value: want };
    await db.prepare(`UPDATE tp_firm_settings SET consultants_own_only = ?, updated_by = ?, updated_at = now(), row_version = row_version + 1
      WHERE firm_id = ?`).run(want, user.id, Number(user.firm_id));
    return { changed: true, value: want };
  })();
}

module.exports = { SETTINGS_PERMISSION, ownOnly, scopedRole, restricted, predicate, filterFor, canSee, visibleIds, keep, setOwnOnly };
