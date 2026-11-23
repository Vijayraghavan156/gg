'use strict';

const access = require('./access');
const { TprmError } = require('./errors');

const SETTINGS_PERMISSION = 'tp.settings';
const DEFAULTS = Object.freeze({ selfApproveTiers: true, selfIssueRecommendations: false });
const REASON_MAX = 1000;

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();

async function settingsFor(db, firmId) {
  const row = await db.prepare(`SELECT managers_self_approve_tiers, managers_self_issue_recommendations, row_version
    FROM tp_firm_settings WHERE firm_id = ?`).get(Number(firmId));
  if (!row) return { ...DEFAULTS, rowVersion: 0 };
  return {
    selfApproveTiers: !!row.managers_self_approve_tiers,
    selfIssueRecommendations: !!row.managers_self_issue_recommendations,
    rowVersion: Number(row.row_version),
  };
}

function requireSettings(user) {
  if (!access.isFirmUser(user) || !user.firm_id || !access.firmCan(user, SETTINGS_PERMISSION)) {
    throw new TprmError(403, 'The firm\'s two-person rules can be changed by managers only.');
  }
}

async function setSettings(db, user, input = {}) {
  requireSettings(user);
  const want = {
    selfApproveTiers: str(input.self_approve_tiers) === '1',
    selfIssueRecommendations: str(input.self_issue_recommendations) === '1',
  };
  return await db.transaction(async () => {
    await db.prepare('INSERT INTO tp_firm_settings (firm_id) VALUES (?) ON CONFLICT (firm_id) DO NOTHING').run(Number(user.firm_id));
    const row = await db.prepare(`SELECT managers_self_approve_tiers, managers_self_issue_recommendations, row_version
      FROM tp_firm_settings WHERE firm_id = ? FOR UPDATE`).get(Number(user.firm_id));
    const expected = Number(input.row_version);
    if (!(expected === Number(row.row_version) || (expected === 0 && Number(row.row_version) === 1))) {
      throw new TprmError(409, 'Someone else changed these settings after you opened the page. Nothing was saved: reload the page and try again.');
    }
    const before = { selfApproveTiers: !!row.managers_self_approve_tiers, selfIssueRecommendations: !!row.managers_self_issue_recommendations };
    if (before.selfApproveTiers === want.selfApproveTiers && before.selfIssueRecommendations === want.selfIssueRecommendations) {
      return { changed: false, before, after: before };
    }
    await db.prepare(`UPDATE tp_firm_settings SET managers_self_approve_tiers = ?, managers_self_issue_recommendations = ?,
        updated_by = ?, updated_at = now(), row_version = row_version + 1 WHERE firm_id = ?`)
      .run(want.selfApproveTiers, want.selfIssueRecommendations, user.id, Number(user.firm_id));
    return { changed: true, before, after: want };
  })();
}

function selfReason(raw, what) {
  const reason = str(raw);
  if (!reason) throw new TprmError(400, `Give the ${what} reason: why you are confirming your own work.`, { errors: [`Give the ${what} reason.`] });
  if (reason.length > REASON_MAX) throw new TprmError(400, `The ${what} reason must be ${REASON_MAX} characters or fewer.`);
  return reason;
}

module.exports = { SETTINGS_PERMISSION, DEFAULTS, REASON_MAX, settingsFor, setSettings, selfReason };
