'use strict';

const access = require('./access');
const placement = require('./placement');
const criticality = require('./criticality');
const { TprmError } = require('./errors');

const MAX_LABELS = 50;

async function get(db, workspaceId) {
  const row = await db.prepare(`SELECT workspace_id, enabled, label_tier_map, vendor_reminders,
      interval_months_critical, interval_months_high, interval_months_medium, interval_months_low, row_version
    FROM tp_client_settings WHERE workspace_id = ?`).get(workspaceId);
  if (!row) {
    return { workspace_id: workspaceId, enabled: false, label_tier_map: {}, interval_months_critical: null,
      interval_months_high: null, interval_months_medium: null, interval_months_low: null, vendor_reminders: true, row_version: 0 };
  }
  const map = row.label_tier_map && typeof row.label_tier_map === 'object' ? row.label_tier_map : {};
  return { ...row, label_tier_map: map };
}

const list = raw => (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(v => String(v == null ? '' : v));

async function intervals(db, ws, settings = null) {
  const current = settings || await get(db, ws.id);
  const firm = await criticality.firmIntervals(db, Number(ws.firm_id));
  return {
    firm: firm.intervals,
    effective: placement.intervalsFor(current, firm.intervals),
    modelVersion: firm.version,
    fallback: firm.fallback,
  };
}

function validate(input) {
  const errors = [];
  const labels = list(input.label);
  const tiers = list(input.tier);
  const map = {};
  const seen = new Set();
  labels.forEach((rawLabel, i) => {
    const label = rawLabel.trim().replace(/\s+/g, ' ');
    const tier = (tiers[i] || '').trim();
    if (!label && !tier) return;
    if (!label) { errors.push('Every mapped tier needs a client label.'); return; }
    if (label.length > 100) { errors.push(`"${label.slice(0, 40)}…" is longer than 100 characters.`); return; }
    if (!placement.isTier(tier)) { errors.push(`Choose a tier for the label "${label}".`); return; }
    const key = placement.labelKey(label);
    if (seen.has(key)) { errors.push(`The label "${label}" is listed twice.`); return; }
    seen.add(key);
    map[label] = tier;
  });
  if (seen.size > MAX_LABELS) errors.push(`Map at most ${MAX_LABELS} labels.`);
  const intervals = {};
  for (const tier of placement.TIERS) {
    const raw = String(input[`interval_months_${tier}`] == null ? '' : input[`interval_months_${tier}`]).trim();
    if (!raw) { intervals[tier] = null; continue; }
    if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 120) {
      errors.push(`${placement.TIER_LABELS[tier]} interval must be a whole number of months from 1 to 120, or blank for the firm default.`);
      intervals[tier] = null;
    } else intervals[tier] = Number(raw);
  }
  const reminders = input.vendor_reminders_shown === '1' ? input.vendor_reminders === '1' : null;
  return { map, intervals, reminders, errors };
}

async function update(db, actor, input) {
  if (!actor || !access.can(actor.user, actor.perms, 'tp.settings')) {
    throw new TprmError(403, 'Only a manager can change third-party risk settings for this client.');
  }
  const { map, intervals, reminders, errors } = validate(input);
  if (errors.length) throw new TprmError(400, errors.join(' '), { errors });
  const rowVersion = Number(input.row_version);
  return await db.transaction(async () => {
    const current = await db.prepare(`SELECT label_tier_map, interval_months_critical, interval_months_high,
        interval_months_medium, interval_months_low, vendor_reminders, row_version FROM tp_client_settings WHERE workspace_id = ? FOR UPDATE`)
      .get(actor.ws.id);
    if (!current) throw new TprmError(404, 'Third-party risk is not switched on for this client.');
    if (!Number.isInteger(rowVersion) || rowVersion !== current.row_version) {
      throw new TprmError(409, 'Someone else changed these settings after you opened them. Nothing was saved: reload the page and make your change again.');
    }
    const before = {
      label_tier_map: current.label_tier_map || {},
      intervals: Object.fromEntries(placement.TIERS.map(t => [t, current[`interval_months_${t}`]])),
      vendor_reminders: current.vendor_reminders,
    };
    const after = { label_tier_map: map, intervals, vendor_reminders: reminders == null ? current.vendor_reminders : reminders };
    if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false, before, after };
    const res = await db.prepare(`UPDATE tp_client_settings SET label_tier_map = ?::jsonb,
        interval_months_critical = ?, interval_months_high = ?, interval_months_medium = ?, interval_months_low = ?,
        vendor_reminders = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND row_version = ?`).run(JSON.stringify(map), intervals.critical, intervals.high,
      intervals.medium, intervals.low, after.vendor_reminders, actor.ws.id, rowVersion);
    if (res.changes !== 1) throw new TprmError(409, 'Someone else changed these settings after you opened them. Nothing was saved: reload the page and make your change again.');
    const recalculated = await require('./register').recalculateProvisional(db, actor);
    return { changed: true, before, after, recalculated };
  })();
}

module.exports = { MAX_LABELS, get, intervals, validate, update };
