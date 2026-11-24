'use strict';

const DAY = 24 * 3600 * 1000;
const DOC_WORDS = /\b(policy|certificate|report|procedure|plan|standard|agreement|template|statement|letter|terms of reference|methodology|schedule|attestation|charter)\b/i;
const DIAGRAM_WORDS = /\b(diagram|screenshot|photo|photograph)\b/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;
const SHEET = /\.(xlsx?|csv|ods)$/i;
const DOC = /\.(pdf|docx?|odt|rtf|txt|md|pptx?)$/i;
const ymd = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

function kindCheck(evidenceText, name) {
  if (!evidenceText || !name) return null;
  if (DOC_WORDS.test(evidenceText) && !DIAGRAM_WORDS.test(evidenceText) && (IMAGE.test(name) || SHEET.test(name))) {
    return { tone: 'attention', key: 'kind', text: `The question asks for ${evidenceText.charAt(0).toLowerCase() + evidenceText.slice(1)}; this is ${IMAGE.test(name) ? 'an image' : 'a spreadsheet'}` };
  }
  if (DIAGRAM_WORDS.test(evidenceText) && SHEET.test(name)) {
    return { tone: 'attention', key: 'kind', text: 'The question asks for a diagram or screenshot; this is a spreadsheet' };
  }
  return null;
}

async function forRows(db, workspaceId, rows, { bankById, reports = [], today }) {
  const ids = [...new Set(rows.flatMap(r => (r.files || []).map(f => Number(f.id))))];
  const out = new Map();
  if (!ids.length) return out;
  const files = await db.prepare(`SELECT id, original_name, size_bytes, sha256 FROM tp_evidence WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
    .all(workspaceId, ...ids);
  const byId = new Map(files.map(f => [Number(f.id), f]));
  const useCount = new Map();
  for (const r of rows) for (const f of (r.files || [])) {
    const sha = (byId.get(Number(f.id)) || {}).sha256;
    if (sha) useCount.set(sha, (useCount.get(sha) || 0) + 1);
  }
  const reportBy = new Map();
  for (const rep of reports) for (const k of ['evidence_id', 'soa_evidence_id', 'bridge_evidence_id']) if (rep[k]) reportBy.set(Number(rep[k]), rep);
  const add = (id, c) => { if (!out.has(id)) out.set(id, []); if (!out.get(id).some(x => x.key === c.key)) out.get(id).push(c); };
  for (const r of rows) {
    const q = bankById.get(r.question_id) || {};
    for (const f of (r.files || [])) {
      const id = Number(f.id);
      const meta = byId.get(id) || {};
      const size = Number(meta.size_bytes) || 0;
      if (size === 0) add(id, { tone: 'problem', key: 'empty', text: 'The file is empty' });
      else if (/\.pdf$/i.test(meta.original_name || '') && size < 2048) add(id, { tone: 'attention', key: 'small', text: 'Very small for a PDF: check it is the real document' });
      const kind = kindCheck(q.evidence, meta.original_name || f.original_name);
      if (kind) add(id, kind);
      if (r.evidence_date && today && daysBetween(ymd(r.evidence_date), today) > 365) {
        add(id, { tone: 'attention', key: 'old', text: `Dated ${ymd(r.evidence_date)}, more than a year ago` });
      }
      const uses = meta.sha256 ? useCount.get(meta.sha256) || 0 : 0;
      if (uses >= 4) add(id, { tone: 'attention', key: 'reused', text: `The same file is given for ${uses} answers` });
      const rep = reportBy.get(id);
      if (rep && rep.certificate_expires_on && today) {
        const exp = ymd(rep.certificate_expires_on);
        if (exp < today) add(id, { tone: 'problem', key: 'expired', text: `The certificate expired on ${exp}` });
        else if (daysBetween(today, exp) <= 60) add(id, { tone: 'attention', key: 'expiring', text: `The certificate expires on ${exp}, within 60 days` });
      }
      if (rep && rep.period_end && today && daysBetween(ymd(rep.period_end), today) > 365) {
        add(id, { tone: 'attention', key: 'period', text: `The report period ended on ${ymd(rep.period_end)}, more than a year ago` });
      }
    }
  }
  return out;
}

module.exports = { kindCheck, forRows };
