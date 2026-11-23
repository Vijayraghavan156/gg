'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const access = require('./access');
const { TprmError } = require('./errors');

const SETTINGS_PERMISSION = 'tp.settings';
const LIMITS = Object.freeze({
  displayName: 200, addressLines: 6, addressLine: 100, address: 600, contactLine: 200, footerText: 300,
  logoBytes: 1024 * 1024, logoDimension: 4000,
});
const LOGO_EXTENSIONS = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' });
const DEFAULT_BRAND_COLOUR = '#1f3a5f';

function contrastWithWhite(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (l + 0.05);
}

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value));
// eslint-disable-next-line no-control-regex
const oneLine = value => str(value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();

function requireSettings(user) {
  if (!access.isFirmUser(user) || !user.firm_id || !access.firmCan(user, SETTINGS_PERMISSION)) {
    throw new TprmError(403, 'The firm\'s letterhead can be changed by managers only.');
  }
}

async function readRow(db, firmId, { forUpdate = false } = {}) {
  return await db.prepare(`SELECT firm_id, display_name, address_lines, contact_line, footer_text, brand_colour, logo_mime, logo_sha256,
      logo_size, logo_name, updated_by, updated_at, row_version
    FROM tp_letterheads WHERE firm_id = ?${forUpdate ? ' FOR UPDATE' : ''}`).get(firmId);
}

function shape(row, firmName) {
  return {
    exists: !!row,
    firmName: firmName || '',
    displayName: (row && row.display_name) || firmName || '',
    customName: (row && row.display_name) || '',
    addressLines: row && row.address_lines ? row.address_lines.split('\n') : [],
    contactLine: (row && row.contact_line) || '',
    footerText: (row && row.footer_text) || '',
    brandColour: (row && row.brand_colour) || null,
    accent: (row && row.brand_colour) || DEFAULT_BRAND_COLOUR,
    logo: row && row.logo_sha256
      ? { mime: row.logo_mime, sha256: row.logo_sha256, size: Number(row.logo_size), name: row.logo_name }
      : null,
    updatedAt: row ? row.updated_at : null,
    rowVersion: row ? Number(row.row_version) : 0,
  };
}

async function getLetterhead(db, firmId) {
  const id = Number(firmId);
  const firm = await db.prepare('SELECT name FROM firms WHERE id = ?').get(id);
  return shape(await readRow(db, id), firm ? firm.name : '');
}

async function logoDataUri(db, firmId) {
  const row = await db.prepare('SELECT logo, logo_mime FROM tp_letterheads WHERE firm_id = ? AND logo IS NOT NULL').get(Number(firmId));
  if (!row || !row.logo || !['image/png', 'image/jpeg'].includes(row.logo_mime)) return null;
  return `data:${row.logo_mime};base64,${Buffer.from(row.logo).toString('base64')}`;
}

function imageSize(b, mime) {
  if (mime === 'image/png') {
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function readLogo(file) {
  const name = String(file.originalname || '').trim().slice(0, 255) || 'logo';
  const mime = LOGO_EXTENSIONS[path.extname(name).toLowerCase()];
  if (!mime) throw new TprmError(400, 'The logo must be a PNG or JPEG image.', { errors: ['The logo must be a PNG or JPEG image.'] });
  const size = Number(file.size) || (file.path ? fs.statSync(file.path).size : 0);
  if (size > LIMITS.logoBytes) throw new TprmError(400, 'The logo must be 1 MB or smaller.', { errors: ['The logo must be 1 MB or smaller.'] });
  const bytes = Buffer.isBuffer(file.buffer) ? file.buffer : fs.readFileSync(file.path);
  if (!bytes.length || bytes.length > LIMITS.logoBytes) throw new TprmError(400, 'The logo must be 1 MB or smaller.', { errors: ['The logo must be 1 MB or smaller.'] });
  const dims = imageSize(bytes, mime);
  if (!dims || !dims.width || !dims.height) {
    throw new TprmError(400, 'The logo could not be read as a PNG or JPEG image.', { errors: ['The logo could not be read as a PNG or JPEG image.'] });
  }
  if (dims.width > LIMITS.logoDimension || dims.height > LIMITS.logoDimension) {
    const msg = `The logo must be at most ${LIMITS.logoDimension.toLocaleString('en-GB')} pixels wide and high.`;
    throw new TprmError(400, msg, { errors: [msg] });
  }
  return { bytes, mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length, name };
}

function parse(input) {
  const errors = [];
  const displayName = oneLine(input.display_name);
  // eslint-disable-next-line no-control-regex
  const lines = str(input.address_lines).replace(/\r\n?/g, '\n').split('\n')
    .map(l => l.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const contactLine = oneLine(input.contact_line);
  const footerText = oneLine(input.footer_text);
  let brandColour = oneLine(input.brand_colour).toLowerCase();
  if (brandColour && !brandColour.startsWith('#')) brandColour = `#${brandColour}`;
  if (brandColour && !/^#[0-9a-f]{6}$/.test(brandColour)) errors.push('The brand colour must be a hex colour such as #1f3a5f.');
  else if (brandColour && contrastWithWhite(brandColour) < 4.5) errors.push('The brand colour is too light for white text on it. Choose a darker shade (contrast with white of at least 4.5 to 1).');
  if (displayName.length > LIMITS.displayName) errors.push(`The firm name must be ${LIMITS.displayName} characters or fewer.`);
  if (lines.length > LIMITS.addressLines) errors.push(`The address can have at most ${LIMITS.addressLines} lines.`);
  if (lines.some(l => l.length > LIMITS.addressLine)) errors.push(`Each address line must be ${LIMITS.addressLine} characters or fewer.`);
  if (lines.join('\n').length > LIMITS.address) errors.push(`The address must be ${LIMITS.address} characters or fewer.`);
  if (contactLine.length > LIMITS.contactLine) errors.push(`The contact line must be ${LIMITS.contactLine} characters or fewer.`);
  if (footerText.length > LIMITS.footerText) errors.push(`The footer must be ${LIMITS.footerText} characters or fewer.`);
  return {
    errors,
    values: {
      display_name: displayName || null,
      address_lines: lines.length ? lines.join('\n') : null,
      contact_line: contactLine || null,
      footer_text: footerText || null,
      brand_colour: brandColour || null,
    },
  };
}

async function saveLetterhead(db, user, input = {}, file = null) {
  requireSettings(user);
  const firmId = Number(user.firm_id);
  const { errors, values } = parse(input);
  const removeLogo = ['1', 'on', 'true'].includes(str(input.remove_logo).toLowerCase());
  let logo = null;
  if (file) {
    try { logo = readLogo(file); } catch (err) { if (err.errors) errors.push(...err.errors); else throw err; }
  }
  if (errors.length) throw new TprmError(400, errors.join(' '), { errors });
  const expected = Number(str(input.row_version));
  return await db.transaction(async () => {
    const row = await readRow(db, firmId, { forUpdate: true });
    const current = row ? Number(row.row_version) : 0;
    if (!Number.isInteger(expected) || expected !== current) {
      throw new TprmError(409, 'Someone else changed the letterhead after you opened this page. Nothing was saved: reload the page and make your change again.');
    }
    const fields = ['display_name', 'address_lines', 'contact_line', 'footer_text', 'brand_colour'].filter(f => (row ? row[f] : null) !== values[f]);
    if (logo && (!row || row.logo_sha256 !== logo.sha256)) fields.push('logo');
    else if (!logo && removeLogo && row && row.logo_sha256) fields.push('logo_removed');
    if (!fields.length) return { changed: false, fields, letterhead: await getLetterhead(db, firmId) };
    const keepLogo = !logo && !removeLogo;
    if (!row) {
      await db.prepare(`INSERT INTO tp_letterheads (firm_id, display_name, address_lines, contact_line, footer_text, brand_colour,
          logo, logo_mime, logo_sha256, logo_size, logo_name, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(firmId, values.display_name, values.address_lines, values.contact_line, values.footer_text, values.brand_colour,
          logo ? logo.bytes : null, logo ? logo.mime : null, logo ? logo.sha256 : null, logo ? logo.size : null, logo ? logo.name : null,
          user.id);
    } else if (keepLogo) {
      await db.prepare(`UPDATE tp_letterheads SET display_name = ?, address_lines = ?, contact_line = ?, footer_text = ?, brand_colour = ?,
          updated_by = ?, updated_at = now(), row_version = row_version + 1 WHERE firm_id = ?`)
        .run(values.display_name, values.address_lines, values.contact_line, values.footer_text, values.brand_colour, user.id, firmId);
    } else {
      await db.prepare(`UPDATE tp_letterheads SET display_name = ?, address_lines = ?, contact_line = ?, footer_text = ?, brand_colour = ?,
          logo = ?, logo_mime = ?, logo_sha256 = ?, logo_size = ?, logo_name = ?,
          updated_by = ?, updated_at = now(), row_version = row_version + 1 WHERE firm_id = ?`)
        .run(values.display_name, values.address_lines, values.contact_line, values.footer_text, values.brand_colour,
          logo ? logo.bytes : null, logo ? logo.mime : null, logo ? logo.sha256 : null, logo ? logo.size : null, logo ? logo.name : null,
          user.id, firmId);
    }
    return { changed: true, fields, letterhead: await getLetterhead(db, firmId) };
  })();
}

async function brandColour(db, firmId) {
  const row = firmId ? await db.prepare('SELECT brand_colour FROM tp_letterheads WHERE firm_id = ?').get(Number(firmId)) : null;
  return (row && row.brand_colour) || DEFAULT_BRAND_COLOUR;
}

module.exports = { SETTINGS_PERMISSION, LIMITS, LOGO_EXTENSIONS, DEFAULT_BRAND_COLOUR, contrastWithWhite, requireSettings, getLetterhead, logoDataUri, saveLetterhead, brandColour, imageSize };
