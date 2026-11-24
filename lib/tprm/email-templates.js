'use strict';

const access = require('./access');
const { TprmError } = require('./errors');

const LIMITS = Object.freeze({ subject: 200, headline: 200, opening: 2000, closing: 2000 });
const FIELDS = Object.keys(LIMITS);
const PERMISSION = 'tp.settings';
const SAMPLE = Object.freeze({ toName: 'Priya Shah', firmName: 'Your firm', clientName: 'Konkan Coastal Bank', thirdPartyName: 'Lumen Print & Mail',
  contact: { name: 'Kabir Mehta', email: 'kabir@firm.example' }, until: '22 Dec 2026', sentDay: '22 Nov 2026', total: 66, answered: 28, files: 3,
  submittedDay: '1 Dec 2026', questionId: 'GOV-01', body: 'Who approves the policy?', url: 'https://app.example/open', response: 'The board.',
  outcomeLabel: 'Approve with conditions', recommendedLabel: 'Approve', version: 2, deciderName: 'Arjun Nair', position: 1,
  conditionText: 'Encrypt the print servers', note: 'Done', issuedDay: '1 Dec 2026', dueDay: '31 Dec 2026', conditions: [{ text: 'Encrypt the print servers', due: '28 Feb 2027' }],
  issueTitle: 'Access reviews', issueBody: 'How is access reviewed?', proposedFix: 'Quarterly reviews', proposedDay: '31 Mar 2027', agreedFix: 'Quarterly reviews',
  agreedDay: '31 Mar 2027', code: '482913', minutes: 10, inviterName: 'Mira Das', sections: ['Access control'], supplierName: 'Orbit Backup', service: 'Nightly backups', authorName: 'Arjun Nair' });

async function forFirm(db, firmId) {
  const rows = await db.prepare(`SELECT t.kind, t.subject, t.headline, t.opening, t.closing, t.updated_at, t.row_version, u.name AS updated_by_name
    FROM tp_email_templates t LEFT JOIN users u ON u.id = t.updated_by WHERE t.firm_id = ?`).all(Number(firmId));
  return new Map(rows.map(r => [r.kind, r]));
}

async function overrideFor(db, firmId, kind) {
  if (!firmId) return null;
  return await db.prepare('SELECT subject, headline, opening, closing FROM tp_email_templates WHERE firm_id = ? AND kind = ?').get(Number(firmId), String(kind)) || null;
}

async function save(db, user, kind, input = {}) {
  if (!access.isFirmUser(user) || !access.firmCan(user, PERMISSION) || !user.firm_id) throw new TprmError(403, 'Only a manager can change the emails.');
  const email = require('../email');
  if (!kinds().includes(kind)) throw new TprmError(404, 'This email does not exist.');
  const errors = [];
  const v = {};
  for (const f of FIELDS) {
    const raw = typeof input[f] === 'string' ? input[f].replace(/\r\n/g, '\n').trim() : '';
    if (raw.length > LIMITS[f]) errors.push(`${f.charAt(0).toUpperCase() + f.slice(1)} must be ${LIMITS[f]} characters or fewer.`);
    if ((f === 'subject' || f === 'headline') && /[\r\n]/.test(raw)) errors.push(`The ${f === 'subject' ? 'subject' : 'heading'} must be one line.`);
    v[f] = raw || null;
  }
  if (errors.length) throw new TprmError(400, errors.join(' '), { errors });
  const firmId = Number(user.firm_id);
  return await db.transaction(async () => {
    const row = await db.prepare('SELECT id, row_version FROM tp_email_templates WHERE firm_id = ? AND kind = ? FOR UPDATE').get(firmId, kind);
    if (row && input.row_version !== undefined && input.row_version !== '' && Number(input.row_version) !== Number(row.row_version)) {
      throw new TprmError(409, 'Someone else changed this email after you opened it. Reload the page and try again.');
    }
    if (input.reset === '1' || FIELDS.every(f => !v[f])) {
      if (row) await db.prepare('DELETE FROM tp_email_templates WHERE id = ?').run(row.id);
      return { reset: true };
    }
    if (row) {
      await db.prepare(`UPDATE tp_email_templates SET subject = ?, headline = ?, opening = ?, closing = ?, updated_by = ?, updated_at = now(),
        row_version = row_version + 1 WHERE id = ?`).run(v.subject, v.headline, v.opening, v.closing, user.id, row.id);
    } else {
      await db.prepare(`INSERT INTO tp_email_templates (firm_id, kind, subject, headline, opening, closing, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(firmId, kind, v.subject, v.headline, v.opening, v.closing, user.id);
    }
    return { saved: true };
  })();
}

function kinds() {
  return ['vendor_invitation', ...Object.keys(require('../email').TPRM_TEMPLATES).filter(k => k !== 'vendor_sign_in_code')];
}

function audienceOf(kind) {
  if (kind.startsWith('vendor_')) return 'the third party';
  if (kind.startsWith('consultant_')) return 'your team';
  return 'the client';
}

async function preview(kind, override, firmName) {
  const email = require('../email');
  if (kind === 'vendor_invitation') {
    return await email.sendVendorQuestionnaireEmail({ renderOnly: true, toEmail: 'x@example.invalid', toName: SAMPLE.toName, clientName: SAMPLE.clientName,
      thirdPartyName: SAMPLE.thirdPartyName, url: SAMPLE.url, expiresAt: new Date(), firmName: firmName || SAMPLE.firmName, expiryDay: SAMPLE.until,
      contact: SAMPLE.contact, facts: { total: 66, sections: 12 }, override });
  }
  return email.renderTprmEmail(kind, { ...SAMPLE, firmName: firmName || SAMPLE.firmName }, override);
}

module.exports = { LIMITS, FIELDS, PERMISSION, SAMPLE, kinds, audienceOf, forFirm, overrideFor, save, preview };
