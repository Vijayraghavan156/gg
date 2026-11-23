'use strict';

const JSZip = require('jszip');
const sax = require('sax');

const DEFAULTS = Object.freeze({ maxChars: 20000, maxPartBytes: 20 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024, maxSheets: 100 });
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

class XlsxError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const STOP = Symbol('stop');

async function readPart(zip, name, maxPartBytes, budget) {
  const file = zip.file(name);
  if (!file) return null;
  const declared = file._data && Number(file._data.uncompressedSize);
  if (Number.isFinite(declared) && (declared > maxPartBytes || declared > budget.left)) throw new XlsxError('XLSX_TOO_LARGE', `${name} is too large`);
  const text = await file.async('string');
  const size = Buffer.byteLength(text);
  if (size > maxPartBytes || size > budget.left) throw new XlsxError('XLSX_TOO_LARGE', `${name} is too large`);
  budget.left -= size;
  return text;
}

function parseXml(xml, { open, close, text }) {
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: false, position: false });
  parser.onerror = err => { throw new XlsxError('XLSX_UNREADABLE', `The workbook XML could not be read: ${err.message}`); };
  if (open) parser.onopentag = node => open(node.name.replace(/^[^:]*:/, ''), node.attributes);
  if (close) parser.onclosetag = name => close(name.replace(/^[^:]*:/, ''));
  if (text) { parser.ontext = text; parser.oncdata = text; }
  parser.ondoctype = () => { throw new XlsxError('XLSX_UNREADABLE', 'The workbook XML declares a DTD.'); };
  try {
    parser.write(xml).close();
  } catch (err) {
    if (err !== STOP) throw err;
  }
}

function attr(attrs, name) {
  if (!attrs) return undefined;
  if (attrs[name] !== undefined) return attrs[name];
  const key = Object.keys(attrs).find(k => k.replace(/^[^:]*:/, '') === name);
  return key === undefined ? undefined : attrs[key];
}

function sharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  let current = null;
  let inT = false;
  let phonetic = 0;
  parseXml(xml, {
    open: (name) => {
      if (name === 'si') current = '';
      else if (name === 'rPh') phonetic += 1;
      else if (name === 't' && current !== null && !phonetic) inT = true;
    },
    close: (name) => {
      if (name === 'si') { out.push(current || ''); current = null; }
      else if (name === 'rPh') phonetic -= 1;
      else if (name === 't') inT = false;
    },
    text: (t) => { if (inT && current !== null) current += t; },
  });
  return out;
}

function isDateFormatCode(code) {
  const bare = String(code || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '')
    .replace(/General/gi, '');
  return /[dmyhs]/i.test(bare);
}

function dateStyles(xml) {
  const custom = new Map();
  const xfs = [];
  if (!xml) return xfs;
  let inCellXfs = false;
  parseXml(xml, {
    open: (name, a) => {
      if (name === 'numFmt') custom.set(Number(attr(a, 'numFmtId')), attr(a, 'formatCode'));
      else if (name === 'cellXfs') inCellXfs = true;
      else if (name === 'xf' && inCellXfs) {
        const id = Number(attr(a, 'numFmtId') || 0);
        xfs.push(BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id))));
      }
    },
    close: (name) => { if (name === 'cellXfs') inCellXfs = false; },
  });
  return xfs;
}

function serialToDate(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = !date1904 && serial < 60 ? serial + 1 : serial;
  const ms = Math.round(days * 86400000);
  const d = new Date(base + ms);
  const iso = d.toISOString();
  return ms % 86400000 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function columnIndex(ref) {
  const m = String(ref || '').match(/^([A-Z]+)/i);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const cleanCell = v => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

function walkSheet(xml, { strings, dates, date1904, onRow }) {
  let row = null;
  let cell = null;
  let into = null;
  let inIsT = false;
  let rowIndex = -1;
  parseXml(xml, {
    open: (name, a) => {
      if (name === 'row') {
        const r = Number(attr(a, 'r'));
        rowIndex = Number.isInteger(r) && r > 0 ? r - 1 : rowIndex + 1;
        row = [];
      } else if (name === 'c' && row) {
        const col = columnIndex(attr(a, 'r'));
        cell = { col: col === null ? row.length : col, t: attr(a, 't') || 'n', s: Number(attr(a, 's') || 0), v: '', is: '', f: false };
      } else if (cell && name === 'v') into = 'v';
      else if (cell && name === 'f') cell.f = true;
      else if (cell && name === 'is') into = 'is';
      else if (cell && into === 'is' && name === 't') inIsT = true;
    },
    close: (name) => {
      if (name === 'v' || name === 'is') into = null;
      else if (name === 't') inIsT = false;
      else if (name === 'c' && cell && row) {
        let value;
        if (cell.t === 's') value = strings[Number(cell.v)] ?? '';
        else if (cell.t === 'inlineStr') value = cell.is;
        else if (cell.t === 'b') value = cell.v === '1' ? 'TRUE' : cell.v === '0' ? 'FALSE' : cell.v;
        else if (cell.t === 'str' || cell.t === 'e') value = cell.v;
        else if (cell.v !== '' && dates[cell.s]) value = serialToDate(Number(cell.v), date1904) || cell.v;
        else value = cell.v;
        if (cell.col < 16384) row[cell.col] = value == null ? '' : String(value);
        cell = null;
      } else if (name === 'row' && row) {
        while (row.length && !row[row.length - 1]) row.pop();
        const done = row;
        row = null;
        onRow(done, rowIndex);
      }
    },
    text: (t) => {
      if (!cell) return;
      if (into === 'v') cell.v += t;
      else if (into === 'is' && inIsT) cell.is += t;
    },
  });
}

function sheetText(xml, { strings, dates, date1904, out, max }) {
  walkSheet(xml, {
    strings, dates, date1904,
    onRow: row => {
      const cleaned = Array.from(row, c => cleanCell(c));
      while (cleaned.length && !cleaned[cleaned.length - 1]) cleaned.pop();
      if (cleaned.length) out.push(cleaned.join(' | '));
      if (out.chars() >= max) throw STOP;
    },
  });
}

function resolveTarget(target) {
  const t = String(target || '');
  if (t.startsWith('/')) return t.slice(1);
  const parts = ['xl'];
  for (const seg of t.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function openWorkbook(buffer, { maxPartBytes, maxTotalBytes }) {
  const budget = { left: maxTotalBytes };
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
  } catch (_) {
    throw new XlsxError('XLSX_UNREADABLE', 'The file is not a readable .xlsx workbook.');
  }
  const workbook = await readPart(zip, 'xl/workbook.xml', maxPartBytes, budget);
  if (!workbook) throw new XlsxError('XLSX_UNREADABLE', 'The file has no workbook.');
  const sheets = [];
  let date1904 = false;
  parseXml(workbook, {
    open: (name, a) => {
      if (name === 'workbookPr') date1904 = ['1', 'true'].includes(String(attr(a, 'date1904') || '').toLowerCase());
      if (name === 'sheet') sheets.push({ name: attr(a, 'name') || `Sheet ${sheets.length + 1}`, rid: attr(a, 'id'), state: attr(a, 'state') || 'visible' });
    },
  });
  const targets = new Map();
  const rels = await readPart(zip, 'xl/_rels/workbook.xml.rels', maxPartBytes, budget);
  if (rels) {
    parseXml(rels, { open: (name, a) => { if (name === 'Relationship') targets.set(attr(a, 'Id'), resolveTarget(attr(a, 'Target'))); } });
  }
  const strings = sharedStrings(await readPart(zip, 'xl/sharedStrings.xml', maxPartBytes, budget));
  const dates = dateStyles(await readPart(zip, 'xl/styles.xml', maxPartBytes, budget));
  const sheetXml = (sheet, i) => readPart(zip, targets.get(sheet.rid) || `xl/worksheets/sheet${i + 1}.xml`, maxPartBytes, budget);
  return { sheets, strings, dates, date1904, sheetXml };
}

async function xlsxToText(buffer, options = {}) {
  const { maxChars, maxPartBytes, maxTotalBytes, maxSheets } = { ...DEFAULTS, ...options };
  const { sheets, strings, dates, date1904, sheetXml } = await openWorkbook(buffer, { maxPartBytes, maxTotalBytes });

  const lines = [];
  let chars = 0;
  const out = {
    push: line => { lines.push(line); chars += line.length + 1; },
    chars: () => chars,
  };
  for (const [i, sheet] of sheets.slice(0, maxSheets).entries()) {
    if (chars >= maxChars) break;
    const xml = await sheetXml(sheet, i);
    if (i > 0) out.push('');
    out.push(`Sheet: ${cleanCell(sheet.name)}${sheet.state !== 'visible' ? ' (hidden)' : ''}`);
    if (!xml) { out.push('(no data)'); continue; }
    const before = lines.length;
    try {
      sheetText(xml, { strings, dates, date1904, out, max: maxChars });
    } catch (err) {
      if (err !== STOP) throw err;
    }
    if (lines.length === before) out.push('(no data)');
  }
  return lines.join('\n');
}

async function xlsxRows(buffer, options = {}) {
  const { maxPartBytes, maxTotalBytes, maxSheets, maxRows = 5000, maxCols = 64 } = { ...DEFAULTS, ...options };
  const { sheets, strings, dates, date1904, sheetXml } = await openWorkbook(buffer, { maxPartBytes, maxTotalBytes });
  const out = [];
  for (const [i, sheet] of sheets.slice(0, maxSheets).entries()) {
    const xml = await sheetXml(sheet, i);
    const rows = [];
    if (xml) {
      walkSheet(xml, {
        strings, dates, date1904,
        onRow: (row, index) => {
          if (!row.length) return;
          if (index >= maxRows) throw new XlsxError('XLSX_TOO_LARGE', `The sheet "${sheet.name}" has more than ${maxRows} rows.`);
          rows.push({ index, cells: Array.from(row.slice(0, maxCols), c => (c == null ? '' : c)) });
        },
      });
    }
    out.push({ name: sheet.name, state: sheet.state, rows });
  }
  return out;
}

module.exports = { xlsxRows, xlsxToText, XlsxError, serialToDate, columnIndex, isDateFormatCode, DEFAULTS };
