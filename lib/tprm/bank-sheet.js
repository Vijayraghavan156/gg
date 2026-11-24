'use strict';

const JSZip = require('jszip');
const { xlsxRows, XlsxError } = require('./xlsx-text');
const { TprmError } = require('./errors');

const SHEET = 'Question bank';
const HEADER_ROW = 3;
const COLUMNS = Object.freeze([
  { key: 'id', label: 'Number (do not change)', width: 12 },
  { key: 'set', label: 'Set', width: 14 },
  { key: 'pack', label: 'Module or rulebook', width: 24 },
  { key: 'domain', label: 'Domain', width: 26 },
  { key: 'theme', label: 'Theme', width: 24, edit: true },
  { key: 'question', label: 'Question', width: 60, edit: true },
  { key: 'guidance', label: 'Guidance', width: 50, edit: true },
  { key: 'evidence', label: 'Evidence asked for', width: 36, edit: true },
  { key: 'evidence_mandatory', label: 'Evidence required (Yes or No)', width: 14, edit: true },
  { key: 'min_tier', label: 'Lowest tier asked', width: 14, edit: true },
  { key: 'benchmark', label: 'Benchmark', width: 40, edit: true },
  { key: 'iso27001', label: 'ISO 27001', width: 12, edit: true },
  { key: 'retire', label: 'Retire (write Retire)', width: 14, edit: true },
]);
const LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024 });

const xmlText = v => String(v == null ? '' : v)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = i => { let n = i + 1; let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const norm = v => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();

function cell(ref, value, style) {
  const v = String(value == null ? '' : value);
  const s = style ? ` s="${style}"` : '';
  if (!v) return style ? `<c r="${ref}"${s}/>` : '';
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
}

function valueOf(q, key) {
  if (key === 'evidence_mandatory') return q.evidence_mandatory ? 'Yes' : 'No';
  if (key === 'retire') return '';
  return q[key] == null ? '' : q[key];
}

function sheetXml(content, title) {
  const out = [];
  const line = (r, values, style) => out.push(`<row r="${r}">${values.map((v, i) => cell(`${colName(i)}${r}`, v, typeof style === 'function' ? style(i) : style)).join('')}</row>`);
  line(1, [title], 1);
  line(2, ['Change the white columns and upload this file on the question bank page. The changes go into the draft, and nothing is published until you publish it. Rows you leave out stay as they are.']);
  line(HEADER_ROW, COLUMNS.map(c => c.label), 2);
  const qs = content.questions || [];
  qs.forEach((q, i) => line(HEADER_ROW + 1 + i, COLUMNS.map(c => valueOf(q, c.key)), c => (COLUMNS[c].edit ? 3 : 4)));
  const last = HEADER_ROW + qs.length;
  const cols = COLUMNS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('');
  const col = k => colName(COLUMNS.findIndex(c => c.key === k));
  const lists = [
    [`${col('evidence_mandatory')}${HEADER_ROW + 1}:${col('evidence_mandatory')}${Math.max(last, HEADER_ROW + 1)}`, 'Yes,No'],
    [`${col('min_tier')}${HEADER_ROW + 1}:${col('min_tier')}${Math.max(last, HEADER_ROW + 1)}`, 'All tiers,Low,Medium,High,Critical'],
    [`${col('retire')}${HEADER_ROW + 1}:${col('retire')}${Math.max(last, HEADER_ROW + 1)}`, 'Retire'],
  ].map(([ref, list]) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${ref}"><formula1>"${list}"</formula1></dataValidation>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${HEADER_ROW}" topLeftCell="A${HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${out.join('')}</sheetData>
<autoFilter ref="A${HEADER_ROW}:${colName(COLUMNS.length - 1)}${Math.max(last, HEADER_ROW)}"/>
<dataValidations count="${lists.length}">${lists.join('')}</dataValidations>
</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F3F5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="49" fontId="0" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

async function buildWorkbook(content, title) {
  const zip = new JSZip();
  const last = HEADER_ROW + (content.questions || []).length;
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${SHEET}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${SHEET}'!$A$${HEADER_ROW}:$${colName(COLUMNS.length - 1)}$${Math.max(last, HEADER_ROW)}</definedName></definedNames></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', STYLES);
  zip.file('xl/worksheets/sheet1.xml', sheetXml(content, title));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function parseUpload(buffer) {
  if (!buffer || !buffer.length) throw new TprmError(400, 'Choose the Excel file to upload.');
  if (buffer.length > LIMITS.fileBytes) throw new TprmError(400, 'The file is larger than 5 MB.');
  let sheets;
  try {
    sheets = await xlsxRows(buffer, { maxRows: 3000, maxCols: COLUMNS.length + 4 });
  } catch (err) {
    if (err instanceof XlsxError) throw new TprmError(400, `This file could not be read as an Excel workbook: ${err.message}`);
    throw err;
  }
  const sheet = sheets.find(s => s.name === SHEET) || sheets[0];
  if (!sheet) throw new TprmError(400, 'The workbook has no sheets.');
  const header = sheet.rows.find(r => norm(r.cells[0]) === COLUMNS[0].label);
  if (!header) throw new TprmError(400, `This is not a question bank file. Download the file from the question bank page and change that one.`);
  const at = {};
  for (const c of COLUMNS) {
    const i = header.cells.findIndex(h => norm(h) === c.label);
    if (i === -1) throw new TprmError(400, `The column "${c.label}" is missing. Download a fresh file from the question bank page.`);
    at[c.key] = i;
  }
  const out = [];
  const seen = new Set();
  const errors = [];
  for (const r of sheet.rows) {
    if (r.index <= header.index) continue;
    const id = norm(r.cells[at.id]).toUpperCase();
    if (!id) continue;
    if (seen.has(id)) { errors.push(`${id} appears twice in the file.`); continue; }
    seen.add(id);
    const get = k => norm(r.cells[at[k]]);
    const retireCell = get('retire').toLowerCase();
    if (retireCell && retireCell !== 'retire') { errors.push(`${id}: the Retire column should say Retire or be empty.`); continue; }
    const mandatory = get('evidence_mandatory').toLowerCase();
    if (!['yes', 'no', ''].includes(mandatory)) { errors.push(`${id}: Evidence required should be Yes or No.`); continue; }
    out.push({
      id,
      retire: retireCell === 'retire',
      values: {
        theme: get('theme'), question: get('question'), guidance: get('guidance'), evidence: get('evidence'),
        evidence_mandatory: mandatory === 'yes' ? '1' : '', min_tier: get('min_tier'), benchmark: get('benchmark'), iso27001: get('iso27001'),
      },
    });
  }
  if (errors.length) throw new TprmError(400, errors.slice(0, 20).join(' '), { errors });
  if (!out.length) throw new TprmError(400, 'The file has no question rows.');
  return out;
}

module.exports = { SHEET, COLUMNS, LIMITS, buildWorkbook, parseUpload };
