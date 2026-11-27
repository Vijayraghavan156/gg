'use strict';

const TIERS = Object.freeze(['critical', 'high', 'medium', 'low']);
const TIER_LABELS = Object.freeze({ critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' });

const STATUSES = Object.freeze(['proposed', 'in_use', 'exited']);
const STATUS_LABELS = Object.freeze({ proposed: 'Proposed', in_use: 'In use', exited: 'Exited' });

const TIER_SOURCE_LABELS = Object.freeze({
  provisional_from_client_label: 'Provisional (client label)',
  assessed: 'Assessed',
});

function isTier(value) {
  return TIERS.includes(value);
}

function isYmd(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 1900;
}

function addMonths(ymd, months) {
  if (!isYmd(ymd)) throw new TypeError(`Not a date: ${ymd}`);
  const [y, m, d] = ymd.split('-').map(Number);
  const firstOfTarget = new Date(Date.UTC(y, m - 1 + Number(months), 1));
  const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth(), Math.min(d, lastDay)));
  return out.toISOString().slice(0, 10);
}

function intervalsFor(settings, firmIntervals) {
  const out = {};
  for (const tier of TIERS) {
    const firm = firmIntervals ? firmIntervals[tier] : undefined;
    if (!Number.isInteger(firm) || firm < 1) throw new TypeError(`No firm interval for the ${tier} tier`);
    const override = settings ? settings[`interval_months_${tier}`] : null;
    out[tier] = Number.isInteger(override) && override > 0 ? override : firm;
  }
  return out;
}

const labelKey = label => String(label == null ? '' : label).trim().replace(/\s+/g, ' ').toLowerCase();

function tierForLabel(labelMap, label) {
  const key = labelKey(label);
  if (!key || !labelMap || typeof labelMap !== 'object') return null;
  for (const [mapped, tier] of Object.entries(labelMap)) {
    if (labelKey(mapped) === key && isTier(tier)) return tier;
  }
  return null;
}

function provisionalPlacement({ status, clientLabel, lastAssessmentDate, designatedCritical = false, labelMap, intervals, today }) {
  const mapped = tierForLabel(labelMap, clientLabel);
  const tier = designatedCritical ? 'critical' : mapped;
  const assessed = !!lastAssessmentDate && isYmd(lastAssessmentDate);
  const nextDueDate = status === 'in_use' && tier && assessed ? addMonths(lastAssessmentDate, intervals[tier]) : null;
  return {
    tier: tier || null,
    tierSource: tier ? 'provisional_from_client_label' : null,
    nextDueDate,
    tierNeeded: !tier,
    labelUnmapped: !!labelKey(clientLabel) && !mapped,
  };
}

function isDue(row, today) {
  return row.status === 'in_use' && (!row.next_due_date || row.next_due_date <= today);
}

module.exports = {
  TIERS, TIER_LABELS, STATUSES, STATUS_LABELS, TIER_SOURCE_LABELS,
  isTier, isYmd, addMonths, intervalsFor, labelKey, tierForLabel, provisionalPlacement, isDue,
};
