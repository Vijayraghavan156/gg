'use strict';

const sheet = require('./question-sheet');
const { TprmError } = require('./errors');

const FIELDS = Object.freeze([
  ['section', 'Section'], ['question', 'Question'], ['theme', 'Short title'], ['guidance', 'Guidance'], ['answer_type', 'How it is answered'],
  ['options', 'Options'], ['allow_other', 'Other allowed'], ['allow_na', 'Not applicable allowed'], ['required', 'Answer required'],
  ['file', 'Supporting file'], ['evidence', 'What the file should be'], ['evidence_mandatory', 'File required'], ['explain_on', 'Explanation needed for'],
  ['show_when', 'Shown when'], ['benchmark', 'Benchmark'], ['valid_answer', 'Marking rule: a valid answer'], ['satisfactory', 'Marking rule: satisfactory when'],
  ['partly', 'Marking rule: partly satisfactory when'], ['red_flags', 'Marking rule: red flags'],
]);

const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);

function describe(q, titles) {
  const st = sheet.settingsCells(q);
  const rules = sheet.ruleCells({ valid_answer: q.ai_valid, satisfactory: q.ai_meets, partly: q.ai_partly, red_flags: q.ai_red_flags });
  return {
    section: titles.get(q.section) || '', question: q.question || '', theme: q.theme_auto ? '' : (q.theme || ''), guidance: q.guidance || '',
    ...st, show_when: st.show_when ? st.show_when.replace(/^all: /, 'All of: ').replace(/^any: /, 'Any of: ') : 'Always', benchmark: q.benchmark || '', ...rules,
  };
}

function compare(before, after) {
  const b = before || { sections: [], questions: [] };
  const bTitles = new Map(b.sections.map(s => [s.key, s.title]));
  const aTitles = new Map(after.sections.map(s => [s.key, s.title]));
  const bById = new Map(b.questions.map(q => [q.id, q]));
  const aById = new Map(after.questions.map(q => [q.id, q]));
  const out = { first: !before, added: [], removed: [], changed: [], sections: { added: [], removed: [], renamed: [] }, reordered: false, count: 0 };
  for (const s of after.sections) {
    if (!bTitles.has(s.key)) out.sections.added.push(s.title);
    else if (bTitles.get(s.key) !== s.title) out.sections.renamed.push({ from: bTitles.get(s.key), to: s.title });
  }
  for (const s of b.sections) if (!aTitles.has(s.key)) out.sections.removed.push(s.title);
  for (const q of after.questions) {
    const was = bById.get(q.id);
    const now = describe(q, aTitles);
    if (!was) { out.added.push({ id: q.id, section: now.section, question: q.question, type: now.answer_type }); continue; }
    const then = describe(was, bTitles);
    const fields = FIELDS.filter(([k]) => (k === 'section' ? was.section !== q.section : sheet.norm(then[k]) !== sheet.norm(now[k])))
      .map(([k, label]) => ({ key: k, label, before: then[k], after: now[k] }));
    if (fields.length) out.changed.push({ id: q.id, question: q.question, fields });
  }
  for (const q of b.questions) if (!aById.has(q.id)) out.removed.push({ id: q.id, question: q.question });
  const kept = id => bById.has(id) && aById.has(id);
  const bOrder = b.questions.map(q => q.id).filter(kept);
  const aOrder = after.questions.map(q => q.id).filter(kept);
  const bSecs = b.sections.map(s => s.key).filter(k => aTitles.has(k));
  const aSecs = after.sections.map(s => s.key).filter(k => bTitles.has(k));
  out.order = { sections: null, questions: [] };
  if (!out.first && bSecs.join() !== aSecs.join()) out.order.sections = after.sections.map(s => s.title);
  if (!out.first) {
    for (const s of after.sections) {
      const was = b.questions.filter(q => q.section === s.key && kept(q.id) && aById.get(q.id).section === s.key).map(q => q.id);
      const now = after.questions.filter(q => q.section === s.key && was.includes(q.id)).map(q => q.id);
      if (was.join() !== now.join()) out.order.questions.push({ title: s.title, ids: after.questions.filter(q => q.section === s.key).map(q => q.id) });
    }
  }
  out.reordered = !out.first && (!!out.order.sections || out.order.questions.length > 0 || (bOrder.join() !== aOrder.join() && !out.changed.some(c => c.fields.some(f => f.key === 'section'))));
  out.count = out.added.length + out.removed.length + out.changed.length + out.sections.added.length + out.sections.removed.length + out.sections.renamed.length + (out.reordered ? 1 : 0);
  return out;
}

async function versions(db, templateId) {
  const rows = await db.prepare(`SELECT v.id, v.version, v.published_at, v.question_count, v.note, u.name AS published_by_name,
      (SELECT count(*) FROM tp_questionnaires q WHERE q.template->>'version_id' = v.id::text) AS used
    FROM tp_q_template_versions v LEFT JOIN users u ON u.id = v.published_by
    WHERE v.template_id = ? ORDER BY v.version DESC`).all(Number(templateId));
  return rows.map(r => ({ id: Number(r.id), version: Number(r.version), publishedAt: r.published_at, questionCount: Number(r.question_count),
    note: r.note || '', by: r.published_by_name || '', used: Number(r.used) }));
}

async function content(db, templateId, version) {
  const r = await db.prepare('SELECT id, version, content, published_at FROM tp_q_template_versions WHERE template_id = ? AND version = ?').get(Number(templateId), Number(version) || 0);
  if (!r) throw new TprmError(404, 'This version does not exist.');
  return { id: Number(r.id), version: Number(r.version), publishedAt: r.published_at, content: parse(r.content) };
}

module.exports = { FIELDS, describe, compare, versions, content };
