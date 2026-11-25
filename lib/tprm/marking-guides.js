'use strict';

const access = require('./access');
const { TprmError } = require('./errors');

const LIMIT = 1500;
const PERMISSION = 'tp.settings';
const QID = /^[A-Z]{2,6}-[0-9]{1,4}$/;

async function forFirm(db, firmId, ids = null) {
  const list = ids ? [...new Set(ids.map(String))].filter(id => QID.test(id)) : null;
  if (list && !list.length) return new Map();
  const rows = await db.prepare(`SELECT g.question_id, g.valid_answer, g.satisfactory, g.partly, g.red_flags, g.updated_at, g.row_version, u.name AS updated_by_name
    FROM tp_marking_guides g LEFT JOIN users u ON u.id = g.updated_by
    WHERE g.firm_id = ?${list ? ` AND g.question_id IN (${list.map(() => '?').join(',')})` : ''}`).all(Number(firmId), ...(list || []));
  return new Map(rows.map(r => [r.question_id, r]));
}

const clean = (v, label, errors) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > LIMIT) errors.push(`${label} must be ${LIMIT} characters or fewer.`);
  return s || null;
};

async function save(db, user, questionId, input = {}) {
  if (!access.isFirmUser(user) || !access.firmCan(user, PERMISSION) || !user.firm_id) {
    throw new TprmError(403, 'Only a manager can change the marking guides.');
  }
  const qid = String(questionId || '');
  if (!QID.test(qid)) throw new TprmError(404, 'This question does not exist.');
  const errors = [];
  const v = { valid_answer: clean(input.valid_answer, 'A valid answer', errors), satisfactory: clean(input.satisfactory, 'Satisfactory when', errors),
    partly: clean(input.partly, 'Partly satisfactory when', errors), red_flags: clean(input.red_flags, 'Red flags', errors) };
  if (errors.length) throw new TprmError(400, errors.join(' '), { errors });
  const firmId = Number(user.firm_id);
  return await db.transaction(async () => {
    const row = await db.prepare('SELECT id, row_version FROM tp_marking_guides WHERE firm_id = ? AND question_id = ? FOR UPDATE').get(firmId, qid);
    if (row && input.row_version !== undefined && Number(input.row_version) !== Number(row.row_version)) {
      throw new TprmError(409, 'Someone else changed this guide after you opened it. Reload the page and try again.');
    }
    if (!v.valid_answer && !v.satisfactory && !v.partly && !v.red_flags) {
      if (row) await db.prepare('DELETE FROM tp_marking_guides WHERE id = ?').run(row.id);
      return { cleared: !!row };
    }
    if (row) {
      await db.prepare(`UPDATE tp_marking_guides SET valid_answer = ?, satisfactory = ?, partly = ?, red_flags = ?, updated_by = ?, updated_at = now(),
        row_version = row_version + 1 WHERE id = ?`).run(v.valid_answer, v.satisfactory, v.partly, v.red_flags, user.id, row.id);
    } else {
      await db.prepare(`INSERT INTO tp_marking_guides (firm_id, question_id, valid_answer, satisfactory, partly, red_flags, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(firmId, qid, v.valid_answer, v.satisfactory, v.partly, v.red_flags, user.id);
    }
    return { saved: true };
  })();
}

async function saveMany(db, user, list) {
  let saved = 0;
  await db.transaction(async () => {
    for (const { id, rules } of list) {
      await save(db, user, id, rules);
      saved += 1;
    }
  })();
  return { saved };
}

function fromQuestion(row) {
  if (!row) return null;
  const g = { valid_answer: row.ai_valid || null, satisfactory: row.ai_meets || null, partly: row.ai_partly || null, red_flags: row.ai_red_flags || null };
  return g.valid_answer || g.satisfactory || g.partly || g.red_flags ? g : null;
}

module.exports = { LIMIT, PERMISSION, forFirm, save, saveMany, fromQuestion };
