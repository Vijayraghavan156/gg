'use strict';

const JSZip = require('jszip');
const rulesLib = require('./answer-rules');
const { xlsxRows, serialToDate, XlsxError } = require('./xlsx-text');
const { TprmError } = require('./errors');

const FORMAT = 1;
const SHEET = 'Questionnaire';
const ABOUT = 'About this file';
const LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024 });
const COLUMNS = Object.freeze(['Reference', 'Section', 'Question', 'Answer', 'Explanation or details', 'Evidence reference', 'Evidence date (YYYY-MM-DD)', 'Allowed answers', 'Notes', 'Confirm carried-over answer', 'Version (do not change)']);
const COL = Object.freeze({ ref: 0, section: 1, question: 2, answer: 3, explain: 4, evRef: 5, evDate: 6, confirm: 9, version: 10 });
const WIDTHS = Object.freeze([12, 22, 60, 22, 50, 28, 16, 26, 40, 18, 22]);
const HEADER_ROW = 4;
const LABELS = rulesLib.RESPONSE_LABELS;
const EMPTY_VERSION = require('./vendor-answers').answerHash(null);
const AMBIGUOUS_DATE = /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/;

const bad = errors => new TprmError(400, errors.map(e => (e.id ? `${e.id}: ${e.message}` : e.message)).join(' '), { errors });
const norm = v => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
const xmlText = v => String(v == null ? '' : v)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = i => { let n = i + 1; let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function allowedLabels(rules) {
  if (rules.typed && rules.type === 'free_text') return rules.fields.length ? ['Not applicable'] : ['Your written answer', 'Not applicable'];
  return rules.responses.map(r => LABELS[r]);
}

function answerCells(rules, a) {
  const out = { answer: '', explain: '', fields: {} };
  if (!a || !a.response) return out;
  const freeText = rules.typed && rules.type === 'free_text';
  const own = a.response === rulesLib.fieldsResponse(rules);
  if (freeText && a.response === 'text') {
    if (!rules.fields.length) out.answer = a.detail || '';
  } else {
    out.answer = LABELS[a.response] || a.response;
  }
  if (own && rules.fields.length) out.fields = { ...(a.fields || {}) };
  else if (own && rules.detailsOnYes) out.explain = a.detail || '';
  else if (!(freeText && a.response === 'text') && (!rules.typed || rulesLib.explanationNeeded(rules, a.response))) out.explain = a.detail || '';
  return out;
}

function noteFor(q, rules) {
  const notes = [];
  if (q.fromLastTime) notes.push('Carried over from your last questionnaire: change it, or type Yes under Confirm carried-over answer if it is still right.');
  if (rules.fields.length && rules.type !== 'free_text') notes.push('If Yes, fill in the rows below.');
  if (rules.detailsOnYes) notes.push(`If Yes: ${rules.detailsOnYes}`);
  if (rules.typed && rules.explainOn.length) notes.push(`Explain ${rules.explainOn.map(r => LABELS[r]).join(' or ')}.`);
  if (q.evidenceRequired) notes.push('Evidence is required: add the file in the portal.');
  return notes.join(' ');
}

function rowsFor(page) {
  const rows = [];
  for (const s of page.sections) {
    for (const q of s.questions) {
      const r = q.rules;
      const cells = answerCells(r, q.answer);
      rows.push({
        kind: 'question', allowed: allowedLabels(r),
        cells: [q.id, s.title, q.question, cells.answer, cells.explain, (q.answer && q.answer.evidence_ref) || '', (q.answer && q.answer.evidence_date) || '',
          r.typed && r.type === 'free_text' && r.fields.length ? 'Fill in the rows below, or Not applicable' : allowedLabels(r).join(', '), noteFor(q, r), '', q.version],
        confirm: !!q.fromLastTime,
      });
      for (const f of r.fields) {
        rows.push({
          kind: 'field', allowed: null,
          cells: [`${q.id}:${f.key}`, '', `${f.label}${f.kind === 'date' ? ' (date, YYYY-MM-DD)' : f.kind === 'number' ? ' (number)' : f.kind === 'multi' ? ` (any of: ${f.options.join('; ')}; separate with ;)` : ''}`,
            cells.fields[f.key] || '', '', '', '', '', f.optional ? 'Optional.' : '', '', ''],
        });
      }
    }
  }
  return rows;
}

function cell(ref, value, style) {
  const v = String(value == null ? '' : value);
  const s = style ? ` s="${style}"` : '';
  if (!v) return style ? `<c r="${ref}"${s}/>` : '';
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
}

function questionSheet(page, rows) {
  const out = [];
  const line = (r, values, style) => out.push(`<row r="${r}">${values.map((v, i) => cell(`${colName(i)}${r}`, v, typeof style === 'function' ? style(i) : style)).join('')}</row>`);
  line(1, [`Security questionnaire for ${page.ctx.clientName}`], 1);
  line(2, ['Fill in the Answer column and the columns to its right, then upload this file on the questionnaire page. A row left empty keeps what is saved in the portal. Files cannot travel in the spreadsheet: add evidence in the portal.']);
  line(HEADER_ROW, COLUMNS, 2);
  const lists = new Map();
  rows.forEach((row, i) => {
    const r = HEADER_ROW + 1 + i;
    line(r, row.cells, c => (c <= 2 || c === 7 || c === 8 || c === 10 || (c === 9 && !row.confirm) ? (row.kind === 'field' ? 5 : 4) : 3));
    if (row.confirm) { if (!lists.has('Yes')) lists.set('Yes', []); lists.get('Yes').push(`J${r}`); }
    if (row.allowed && !(row.allowed.length === 2 && row.allowed[0] === 'Your written answer')) {
      const key = row.allowed.join(',');
      if (key.length <= 250) { if (!lists.has(key)) lists.set(key, []); lists.get(key).push(`D${r}`); }
    }
  });
  const last = HEADER_ROW + rows.length;
  const cols = WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"${i === COL.version ? ' hidden="1"' : ''}/>`).join('');
  const validations = [...lists.entries()].map(([key, refs]) => `<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${refs.join(' ')}"><formula1>"${xmlText(key)}"</formula1></dataValidation>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${HEADER_ROW}" topLeftCell="A${HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${out.join('')}</sheetData>
<autoFilter ref="A${HEADER_ROW}:K${Math.max(last, HEADER_ROW)}"/>
${validations.length ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>` : ''}
</worksheet>`;
}

function aboutSheet(page) {
  const rows = [['format', String(FORMAT)], ['questionnaire', String(page.ctx.questionnaireId)], ['bank_version', String(page.bankVersionId)]];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${cell(`A${i + 1}`, r[0])}${cell(`B${i + 1}`, r[1])}</row>`).join('')}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F3F5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="49" fontId="0" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1" applyProtection="1"><alignment vertical="top" wrapText="1"/><protection locked="1"/></xf>
<xf numFmtId="49" fontId="0" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1" indent="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

async function buildWorkbook(page) {
  const rows = rowsFor(page);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${SHEET}" sheetId="1" r:id="rId1"/><sheet name="${ABOUT}" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${SHEET}'!$A$${HEADER_ROW}:$K$${Math.max(HEADER_ROW + rows.length, HEADER_ROW)}</definedName></definedNames></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', STYLES);
  zip.file('xl/worksheets/sheet1.xml', questionSheet(page, rows));
  zip.file('xl/worksheets/sheet2.xml', aboutSheet(page));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function pageFor(db, ctx) {
  const page = await require('./vendor-answers').pageData(db, ctx);
  const q = await db.prepare('SELECT bank_version_id FROM tp_questionnaires WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, ctx.questionnaireId);
  return { ...page, bankVersionId: q ? Number(q.bank_version_id) : null };
}

function fileName(clientName) {
  const safe = String(clientName || 'questionnaire').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'questionnaire';
  return `security-questionnaire-${safe}.xlsx`;
}

function dateValue(v) {
  const s = norm(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return s.slice(0, 10);
  if (/^\d{4,5}(?:\.\d+)?$/.test(s)) {
    const d = serialToDate(Number(s), false);
    if (d && d >= '1990-01-01') return d.slice(0, 10);
  }
  return s;
}

function numberValue(v) {
  const s = norm(v);
  return /^-?\d+\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s;
}

function responseFor(rules, raw) {
  const s = norm(raw).toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (!s) return '';
  const synonyms = { yes: ['yes', 'y'], no: ['no', 'n'], na: ['not applicable', 'n/a', 'na', 'n.a'], partial: ['partially', 'partial'] };
  for (const r of rules.responses) {
    if (r === 'text') continue;
    if ((synonyms[r] || [String(LABELS[r] || r).toLowerCase()]).includes(s)) return r;
  }
  return null;
}

function readAbout(sheets) {
  const about = sheets.find(s => s.name === ABOUT);
  if (!about) return null;
  const map = {};
  for (const r of about.rows) if (r.cells[0]) map[norm(r.cells[0])] = norm(r.cells[1]);
  return map;
}

async function parseUpload(buffer, page) {
  let sheets;
  try {
    sheets = await xlsxRows(buffer, { maxRows: 4000, maxCols: 16, maxSheets: 10, maxPartBytes: 10 * 1024 * 1024, maxTotalBytes: 30 * 1024 * 1024 });
  } catch (err) {
    if (err instanceof XlsxError) throw bad([{ message: 'The file could not be read as an Excel workbook (.xlsx). Download the spreadsheet again and fill that in.' }]);
    throw err;
  }
  const about = readAbout(sheets);
  const main = sheets.find(s => s.name === SHEET);
  if (!about || !main || Number(about.format) !== FORMAT) {
    throw bad([{ message: 'This is not the questionnaire spreadsheet from this page. Download it with the link on this page, fill it in, and upload that file.' }]);
  }
  if (Number(about.questionnaire) !== Number(page.ctx.questionnaireId) || Number(about.bank_version) !== Number(page.bankVersionId)) {
    throw bad([{ message: 'This spreadsheet is for a different questionnaire. Download the spreadsheet from this page and copy your answers into it.' }]);
  }
  const header = main.rows.find(r => r.index === HEADER_ROW - 1);
  if (!header || norm(header.cells[COL.ref]) !== COLUMNS[0] || norm(header.cells[COL.answer]) !== COLUMNS[COL.answer]) {
    throw bad([{ message: 'The columns of the spreadsheet were moved or renamed. Download it again and keep the columns as they are.' }]);
  }
  const questions = new Map();
  for (const s of page.sections) for (const q of s.questions) questions.set(q.id, q);
  const seen = new Map();
  const errors = [];
  for (const r of main.rows) {
    if (r.index < HEADER_ROW) continue;
    const ref = norm(r.cells[COL.ref]);
    if (!ref) {
      if ([COL.answer, COL.explain, COL.evRef, COL.evDate].some(c => norm(r.cells[c]))) errors.push({ message: `Row ${r.index + 1} has an answer but no reference. Keep the Reference column as it was downloaded.` });
      continue;
    }
    const m = ref.match(/^([A-Z]{2,6}-\d{1,4})(?::([A-Za-z0-9_]+))?$/);
    const q = m && questions.get(m[1]);
    if (!q || (m[2] && !q.rules.fields.some(f => f.key === m[2]))) {
      errors.push({ message: `Row ${r.index + 1}: "${ref.slice(0, 40)}" is not a question in this questionnaire.` });
      continue;
    }
    if (!seen.has(q.id)) seen.set(q.id, { q, row: null, fields: {} });
    const entry = seen.get(q.id);
    if (m[2]) entry.fields[m[2]] = r.cells[COL.answer];
    else entry.row = r.cells;
  }
  if (errors.length) throw bad(errors.slice(0, 20));

  const body = { r: {}, d: {}, t: {}, y: {}, f: {}, ref: {}, date: {}, v: {} };
  let posted = 0;
  for (const { q, row, fields } of seen.values()) {
    const rules = q.rules;
    const a = q.answer || null;
    const stored = answerCells(rules, a);
    const keep = (incoming, saved) => (norm(incoming) === norm(saved) ? (saved || '') : norm(incoming));
    const cells = row || [];
    const answerRaw = norm(cells[COL.answer]);
    const explain = norm(cells[COL.explain]);
    const evRef = norm(cells[COL.evRef]);
    const evDate = dateValue(cells[COL.evDate]);
    const fieldValues = {};
    for (const f of rules.fields) {
      const raw = fields[f.key];
      fieldValues[f.key] = f.kind === 'date' ? dateValue(raw) : f.kind === 'number' ? numberValue(raw) : norm(raw);
    }
    const anyField = Object.values(fieldValues).some(Boolean);
    const confirm = !!q.fromLastTime && responseFor({ responses: ['yes'] }, cells[COL.confirm]) === 'yes';
    const ambiguous = [['the evidence date', evDate], ...rules.fields.filter(f => f.kind === 'date').map(f => [f.label, fieldValues[f.key]])]
      .filter(([, v]) => AMBIGUOUS_DATE.test(v || ''));
    if (ambiguous.length) {
      for (const [label] of ambiguous) errors.push({ id: q.id, message: `Write ${label} as YYYY-MM-DD, for example 2026-04-03, so the day and month cannot be read the wrong way round.` });
      continue;
    }
    if (!answerRaw && !explain && !evRef && !evDate && !anyField && !confirm) continue;
    if (confirm) { body.confirm = body.confirm || {}; body.confirm[q.id] = '1'; }
    const freeText = rules.typed && rules.type === 'free_text';
    let response;
    if (freeText) {
      const na = responseFor({ responses: ['na'] }, answerRaw) === 'na';
      if (na) response = 'na';
      else if (rules.fields.length) response = anyField ? 'text' : '';
      else response = answerRaw ? 'text' : '';
      if (response === 'na') body.r[q.id] = 'na';
      else if (!rules.fields.length) body.t[q.id] = keep(cells[COL.answer], stored.answer);
    } else {
      response = responseFor(rules, answerRaw);
      if (response === null) {
        errors.push({ id: q.id, message: `"${answerRaw.slice(0, 40)}" is not an answer to this question. Use ${allowedLabels(rules).join(', ')}.` });
        continue;
      }
      body.r[q.id] = response;
    }
    const own = response && response === rulesLib.fieldsResponse(rules);
    if (rules.fields.length) {
      body.f[q.id] = {};
      for (const f of rules.fields) body.f[q.id][f.key] = keep(fieldValues[f.key], stored.fields[f.key]);
    }
    if (own && rules.detailsOnYes && !rules.fields.length) body.y[q.id] = keep(cells[COL.explain], stored.explain);
    else body.d[q.id] = keep(cells[COL.explain], stored.explain);
    body.ref[q.id] = keep(cells[COL.evRef], a && a.evidence_ref);
    body.date[q.id] = evDate;
    body.v[q.id] = /^[0-9a-f]{20}$/.test(norm(cells[COL.version])) ? norm(cells[COL.version]) : EMPTY_VERSION;
    posted += 1;
  }
  if (errors.length) throw bad(errors.slice(0, 40));
  for (const k of Object.keys(body)) if (!Object.keys(body[k]).length) delete body[k];
  return { body, posted };
}

module.exports = { LIMITS, SHEET, ABOUT, COLUMNS, HEADER_ROW, pageFor, buildWorkbook, parseUpload, fileName, rowsFor, dateValue, responseFor };
