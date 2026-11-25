'use strict';

const { xlsxRows, XlsxError } = require('./xlsx-text');
const { TprmError } = require('./errors');
const writer = require('./sheet-writer');
const qs = require('./question-sheet');

const SHEET = 'Questionnaire';
const HEADER_ROW = 3;
const COLUMNS = Object.freeze([
  { key: 'id', label: 'Number (leave empty for a new question)', width: 14 },
  { key: 'section', label: 'Section', width: 24 },
  { key: 'question', label: 'Question', width: 60 },
  { key: 'theme', label: 'Short title', width: 24 },
  { key: 'guidance', label: 'Guidance', width: 44 },
  ...qs.SETTINGS_COLUMNS,
  { key: 'benchmark', label: 'Benchmark', width: 36 },
  ...qs.RULE_COLUMNS,
  { key: 'remove', label: 'Remove (write Remove)', width: 14 },
]);
const LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, rows: 600 });
const norm = qs.norm;

const rulesOf = q => ({ valid_answer: q.ai_valid, satisfactory: q.ai_meets, partly: q.ai_partly, red_flags: q.ai_red_flags });

function rowOf(q, titles) {
  return {
    id: q.id, section: titles.get(q.section) || '', question: q.question, theme: q.theme_auto ? '' : q.theme, guidance: q.guidance || '',
    ...qs.settingsCells(q), benchmark: q.benchmark || '', ...qs.ruleCells(rulesOf(q)), remove: '',
  };
}

async function buildWorkbook(t, questions, title) {
  const titles = new Map(t.draft.sections.map(s => [s.key, s.title]));
  return writer.buildWorkbook({
    sheet: SHEET, title, headerRow: HEADER_ROW,
    note: 'Change any column and upload this file on the questionnaire page. Leave the number empty to add a question; a new section name adds a section. Write Remove to take a question out. Moving rows in this file does not change the order: drag questions on the page for that. The changes go into the draft and reach third parties only when you publish.',
    columns: COLUMNS.map(c => ({ ...c, edit: true })),
    rows: questions.map(q => rowOf(q, titles)),
    lists: [['allow_other', ['Yes', 'No']], ['allow_na', ['Yes', 'No']], ['required', ['Yes', 'No']], ['evidence_mandatory', ['Yes', 'No']],
      ['file', Object.values(qs.FILE_LABELS)], ['remove', ['Remove']]],
  });
}

async function parseUpload(buffer) {
  if (!buffer || !buffer.length) throw new TprmError(400, 'Choose the Excel file to upload.');
  if (buffer.length > LIMITS.fileBytes) throw new TprmError(400, 'The file is larger than 5 MB.');
  let sheets;
  try {
    sheets = await xlsxRows(buffer, { maxRows: 1000, maxCols: COLUMNS.length + 6 });
  } catch (err) {
    if (err instanceof XlsxError) throw new TprmError(400, `This file could not be read as an Excel workbook: ${err.message}`);
    throw err;
  }
  const sheet = sheets.find(s => s.name === SHEET) || sheets[0];
  if (!sheet) throw new TprmError(400, 'The workbook has no sheets.');
  const header = sheet.rows.find(r => norm(r.cells[0]) === COLUMNS[0].label);
  if (!header) throw new TprmError(400, 'This is not a questionnaire file. Download the file from the questionnaire page and change that one.');
  const at = {};
  for (const c of COLUMNS) {
    const i = header.cells.findIndex(h => norm(h) === c.label);
    if (i === -1) throw new TprmError(400, `The column "${c.label}" is missing. Download a fresh file from the questionnaire page.`);
    at[c.key] = i;
  }
  const out = [];
  const seen = new Set();
  const errors = [];
  for (const r of sheet.rows) {
    if (r.index <= header.index) continue;
    const get = k => norm(r.cells[at[k]]);
    if (COLUMNS.every(c => !get(c.key))) continue;
    const id = get('id').toUpperCase();
    const where = id || `Row ${r.index + 1}`;
    if (id && seen.has(id)) { errors.push(`${id} appears twice in the file.`); continue; }
    if (id) seen.add(id);
    const removeCell = get('remove').toLowerCase();
    if (removeCell && removeCell !== 'remove') { errors.push(`${where}: the Remove column should say Remove or be empty.`); continue; }
    if (removeCell) {
      if (!id) { errors.push(`${where}: only a question with a number can be removed.`); continue; }
      out.push({ id, row: r.index + 1, remove: true });
      continue;
    }
    const rowErrors = [...qs.ruleLengthProblems(get, where)];
    const input = qs.inputFromCells(get, where, rowErrors);
    Object.assign(input, { question: get('question'), theme: get('theme'), guidance: get('guidance'), benchmark: get('benchmark') });
    const rules = qs.rulesFromCells(get);
    Object.assign(input, { ai_valid: rules.valid_answer, ai_meets: rules.satisfactory, ai_partly: rules.partly, ai_red_flags: rules.red_flags });
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    out.push({ id: id || null, row: r.index + 1, section: get('section'), input });
  }
  if (errors.length) throw new TprmError(400, errors.slice(0, 20).join(' '), { errors });
  if (!out.length) throw new TprmError(400, 'The file has no question rows.');
  if (out.length > LIMITS.rows) throw new TprmError(400, `The file has more than ${LIMITS.rows} rows.`);
  return out;
}

module.exports = { SHEET, COLUMNS, LIMITS, rowOf, buildWorkbook, parseUpload };
