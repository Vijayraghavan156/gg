'use strict';

const access = require('./access');
const { TprmError } = require('./errors');
const markup = require('./email-markup');

const LIMITS = Object.freeze({ subject: 200, headline: 200, opening: 2000, closing: 2000 });
const FIELDS = Object.keys(LIMITS);
const PERMISSION = 'tp.settings';
const SAMPLE = Object.freeze({ toName: 'Priya Shah', firmName: 'Your firm', clientName: 'Konkan Coastal Bank', thirdPartyName: 'Lumen Print & Mail',
  contact: { name: 'Kabir Mehta', email: 'kabir@firm.example' }, until: '22 Dec 2026', sentDay: '22 Nov 2026', total: 66, answered: 28, files: 3,
  submittedDay: '1 Dec 2026', questionId: 'GOV-01', body: 'Who approves the policy?', url: 'https://app.example/open', response: 'The board.',
  outcomeLabel: 'Approve with conditions', recommendedLabel: 'Approve', version: 2, deciderName: 'Arjun Nair', position: 1,
  conditionText: 'Encrypt the print servers', note: 'Done', issuedDay: '1 Dec 2026', dueDay: '31 Dec 2026', conditions: [{ text: 'Encrypt the print servers', due: '28 Feb 2027' }],
  issueTitle: 'Access reviews', issueBody: 'How is access reviewed?', proposedFix: 'Quarterly reviews', proposedDay: '31 Mar 2027', agreedFix: 'Quarterly reviews',
  agreedDay: '31 Mar 2027', byName: 'Kabir Mehta', tierLabel: 'High', comment: 'Please recheck the data the service handles.', code: '482913', minutes: 10, inviterName: 'Mira Das', sections: ['Access control'], supplierName: 'Orbit Backup', service: 'Nightly backups', authorName: 'Arjun Nair' });

async function forFirm(db, firmId) {
  const rows = await db.prepare(`SELECT t.kind, t.subject, t.headline, t.opening, t.closing, t.format, t.updated_at, t.row_version, u.name AS updated_by_name
    FROM tp_email_templates t LEFT JOIN users u ON u.id = t.updated_by WHERE t.firm_id = ?`).all(Number(firmId));
  return new Map(rows.map(r => [r.kind, r]));
}

async function overrideFor(db, firmId, kind) {
  if (!firmId) return null;
  return await db.prepare('SELECT subject, headline, opening, closing, format FROM tp_email_templates WHERE firm_id = ? AND kind = ?').get(Number(firmId), String(kind)) || null;
}

const WHERE = Object.freeze({ subject: 'Subject', headline: 'Heading', opening: 'Opening words', closing: 'Closing words' });

function canEdit(user) {
  return access.isFirmUser(user) && access.firmCan(user, PERMISSION) && !!user.firm_id;
}

function editable(kind) {
  return kinds().includes(kind) && !kind.startsWith('consultant_');
}

const fieldCache = new Map();
async function fieldsFor(kind) {
  if (fieldCache.has(kind)) return fieldCache.get(kind);
  const std = await preview(kind, null, SAMPLE.firmName);
  const fields = [...markup.BASE_FIELDS];
  if (std.html.includes(SAMPLE.until) || std.html.includes(SAMPLE.dueDay)) fields.push('due');
  if (std.html.includes(SAMPLE.contact.email)) fields.push('contact');
  fieldCache.set(kind, fields);
  return fields;
}

async function clean(kind, input = {}) {
  const errors = [];
  const v = {};
  const rich = input.format === 'rich';
  if (rich && !editable(kind)) throw new TprmError(400, 'This email keeps the simple wording form.');
  const allowed = rich ? await fieldsFor(kind) : null;
  for (const f of FIELDS) {
    const raw = typeof input[f] === 'string' ? input[f].replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim() : '';
    if (raw.length > LIMITS[f]) errors.push(`${f.charAt(0).toUpperCase() + f.slice(1)} must be ${LIMITS[f]} characters or fewer.`);
    if ((f === 'subject' || f === 'headline') && /[\r\n]/.test(raw)) errors.push(`The ${f === 'subject' ? 'subject' : 'heading'} must be one line.`);
    if (rich && raw) errors.push(...(f === 'subject' || f === 'headline' ? markup.lineProblems(raw, allowed, WHERE[f]) : markup.problems(raw, allowed, WHERE[f])));
    v[f] = raw || null;
  }
  v.format = rich ? 'rich' : 'plain';
  return { v, errors };
}

async function draftOverride(kind, input) {
  const { v, errors } = await clean(kind, input);
  return { override: FIELDS.some(f => v[f]) ? v : null, errors };
}

async function save(db, user, kind, input = {}) {
  if (!canEdit(user)) throw new TprmError(403, 'Only a manager can change the emails.');
  if (!kinds().includes(kind)) throw new TprmError(404, 'This email does not exist.');
  const { v, errors } = await clean(kind, input);
  if (errors.length) throw new TprmError(400, errors.join(' '), { errors });
  const firmId = Number(user.firm_id);
  return await db.transaction(async () => {
    const row = await db.prepare(`SELECT id, row_version, subject, headline, opening, closing, format, updated_by, updated_at FROM tp_email_templates
      WHERE firm_id = ? AND kind = ? FOR UPDATE`).get(firmId, kind);
    if (row && input.row_version !== undefined && input.row_version !== '' && Number(input.row_version) !== Number(row.row_version)) {
      throw new TprmError(409, 'Someone else changed this email after you opened it. Reload the page and try again.');
    }
    if (row && editable(kind) && !(await db.prepare('SELECT 1 FROM tp_email_template_versions WHERE firm_id = ? AND kind = ? LIMIT 1').get(firmId, kind))) {
      await db.prepare(`INSERT INTO tp_email_template_versions (firm_id, kind, subject, headline, opening, closing, format, is_standard, saved_by, saved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, false, ?, (SELECT updated_at FROM tp_email_templates WHERE id = ?))`).run(firmId, kind, row.subject, row.headline, row.opening, row.closing, row.format || 'plain', row.updated_by, row.id);
    }
    const keep = async standard => {
      if (!editable(kind)) return;
      await db.prepare(`INSERT INTO tp_email_template_versions (firm_id, kind, subject, headline, opening, closing, format, is_standard, saved_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(firmId, kind, standard ? null : v.subject, standard ? null : v.headline, standard ? null : v.opening,
        standard ? null : v.closing, standard ? 'plain' : v.format, standard, user.id);
    };
    if (input.reset === '1' || FIELDS.every(f => !v[f])) {
      if (row) {
        await db.prepare('DELETE FROM tp_email_templates WHERE id = ?').run(row.id);
        await keep(true);
      }
      return { reset: true };
    }
    if (row) {
      await db.prepare(`UPDATE tp_email_templates SET subject = ?, headline = ?, opening = ?, closing = ?, format = ?, updated_by = ?, updated_at = now(),
        row_version = row_version + 1 WHERE id = ?`).run(v.subject, v.headline, v.opening, v.closing, v.format, user.id, row.id);
    } else {
      await db.prepare(`INSERT INTO tp_email_templates (firm_id, kind, subject, headline, opening, closing, format, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(firmId, kind, v.subject, v.headline, v.opening, v.closing, v.format, user.id);
    }
    await keep(false);
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

async function versions(db, firmId, kind, limit = 20) {
  return await db.prepare(`SELECT v.id, v.subject, v.headline, v.opening, v.closing, v.format, v.is_standard, v.saved_at, u.name AS saved_by_name
    FROM tp_email_template_versions v LEFT JOIN users u ON u.id = v.saved_by
    WHERE v.firm_id = ? AND v.kind = ? ORDER BY v.id DESC LIMIT ?`).all(Number(firmId), String(kind), Number(limit));
}

async function version(db, firmId, kind, id) {
  return await db.prepare(`SELECT id, subject, headline, opening, closing, format, is_standard FROM tp_email_template_versions
    WHERE firm_id = ? AND kind = ? AND id = ?`).get(Number(firmId), String(kind), Number(id) || 0) || null;
}

async function restore(db, user, kind, id, rowVersion) {
  if (!canEdit(user)) throw new TprmError(403, 'Only a manager can change the emails.');
  if (!editable(kind)) throw new TprmError(404, 'This email does not exist.');
  const v = await version(db, user.firm_id, kind, id);
  if (!v) throw new TprmError(404, 'This earlier version does not exist.');
  if (v.is_standard) return await save(db, user, kind, { reset: '1', row_version: rowVersion });
  return await save(db, user, kind, { subject: v.subject || '', headline: v.headline || '', opening: v.opening || '', closing: v.closing || '',
    format: v.format, row_version: rowVersion });
}

function editorSource(saved) {
  if (!saved) return { subject: '', headline: '', opening: '', closing: '' };
  if (saved.format === 'rich') return { subject: saved.subject || '', headline: saved.headline || '', opening: saved.opening || '', closing: saved.closing || '' };
  return { subject: saved.subject || '', headline: saved.headline || '', opening: markup.fromPlain(saved.opening), closing: markup.fromPlain(saved.closing) };
}

async function sendTest(user, kind, override, firmName) {
  if (!canEdit(user)) throw new TprmError(403, 'Only a manager can change the emails.');
  if (!editable(kind)) throw new TprmError(404, 'This email does not exist.');
  if (!user.email) throw new TprmError(400, 'Your account has no email address to send the test to.');
  const email = require('../email');
  const m = await preview(kind, override, firmName);
  const r = await email.sendEmail({ to: user.email, subject: `Test: ${m.subject}`, html: m.html, text: m.text, firmId: user.firm_id,
    relatedType: `tprm_test:${kind}`, outboxRedactions: [SAMPLE.url] });
  if (!r || !r.ok) throw new TprmError(400, `The test email could not be sent: ${String((r && r.error) || 'not sent').slice(0, 200)}`);
  if (r.provider === 'disabled') throw new TprmError(400, 'Email delivery is switched off on this server, so the test was not sent.');
  return { to: user.email };
}

module.exports = { LIMITS, FIELDS, PERMISSION, SAMPLE, WHERE, kinds, audienceOf, canEdit, editable, fieldsFor, draftOverride, forFirm, overrideFor,
  save, preview, versions, version, restore, editorSource, sendTest };
