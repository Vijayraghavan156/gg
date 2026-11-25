'use strict';

const { xlsxRows, XlsxError } = require('./xlsx-text');
const { TprmError } = require('./errors');
const writer = require('./sheet-writer');
const qs = require('./question-sheet');

const SHEET = 'Question bank';
const HEADER_ROW = 3;
const SETTING_KEYS = Object.freeze(['answer_type', 'options', 'allow_other', 'allow_na', 'required', 'file', 'explain_on', 'show_when']);
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
  ...qs.SETTINGS_COLUMNS.filter(c => SETTING_KEYS.includes(c.key)).map(c => ({ ...c, edit: c.key !== 'answer_type', optional: true })),
  ...qs.RULE_COLUMNS.map(c => ({ ...c, edit: true, optional: true })),
  { key: 'retire', label: 'Retire (write Retire)', width: 14, edit: true },
]);
const LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024 });
const norm = qs.norm;

function rowOf(q, guide) {
  const row = { ...q, evidence_mandatory: q.evidence_mandatory ? 'Yes' : 'No', retire: '' };
  const st = qs.settingsCells(q);
  for (const k of SETTING_KEYS) row[k] = st[k];
  Object.assign(row, qs.ruleCells(guide));
  return row;
}

async function buildWorkbook(content, title, guides = new Map()) {
  return writer.buildWorkbook({
    sheet: SHEET, title, headerRow: HEADER_ROW,
    note: 'Change the white columns and upload this file on the question bank page. Question changes go into the draft, and nothing is published until you publish it. Marking rules are your firm\'s own and are saved straight away. Rows you leave out stay as they are.',
    columns: COLUMNS.map(c => ({ ...c, edit: !!c.edit })),
    rows: (content.questions || []).map(q => rowOf(q, guides.get(q.id))),
    lists: [['evidence_mandatory', ['Yes', 'No']], ['min_tier', ['All tiers', 'Low', 'Medium', 'High', 'Critical']], ['allow_other', ['Yes', 'No']], ['allow_na', ['Yes', 'No']],
      ['required', ['Yes', 'No']], ['file', Object.values(qs.FILE_LABELS).filter(x => x !== 'Always')], ['retire', ['Retire']]],
  });
}

async function parseUpload(buffer) {
  if (!buffer || !buffer.length) throw new TprmError(400, 'Choose the Excel file to upload.');
  if (buffer.length > LIMITS.fileBytes) throw new TprmError(400, 'The file is larger than 5 MB.');
  let sheets;
  try {
    sheets = await xlsxRows(buffer, { maxRows: 3000, maxCols: COLUMNS.length + 6 });
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
    if (i === -1 && c.optional) continue;
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
    const cell = k => (at[k] === undefined ? null : norm(r.cells[at[k]]));
    const retireCell = get('retire').toLowerCase();
    if (retireCell && retireCell !== 'retire') { errors.push(`${id}: the Retire column should say Retire or be empty.`); continue; }
    const mandatory = get('evidence_mandatory').toLowerCase();
    if (!['yes', 'no', ''].includes(mandatory)) { errors.push(`${id}: Evidence required should be Yes or No.`); continue; }
    const lengthProblems = qs.ruleLengthProblems(k => cell(k) || '', id);
    if (lengthProblems.length) { errors.push(...lengthProblems); continue; }
    const cells = {};
    for (const c of COLUMNS) if (c.optional) cells[c.key] = cell(c.key);
    out.push({
      id,
      cells,
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
