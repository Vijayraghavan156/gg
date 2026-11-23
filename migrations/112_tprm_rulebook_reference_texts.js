'use strict';

// Third-party risk (TPRM) v2: client-facing rulebook reference texts
// (product decision, 21 Nov 2026; docs/tprm-v2-spec.md sections 4i and 4j).
// Migrations 083-111 are applied and frozen; this one adds a column, replaces
// the seed function by name and updates rows.
//
// The reference text of a rulebook is quoted in the automatic exit plan
// condition, which the client reads in the portal and the PDF. Until now it
// was seeded from the question bank's source text, which carries links and
// research remarks ("para refs to verify", "partly unverified"). From here:
//
//   reference_text  the client-facing citation (data/tprm-rulebooks.js
//                   REFERENCES), versioned as before.
//   research_note   NEW, firm-only: the research remarks and the bank's own
//                   source text with its links. Shown on the manager's
//                   rulebook page only. Not part of a version (it never
//                   reaches a client or an assessment), so 109's guard leaves
//                   it free; a change is audit-logged by the application.
//
// 1. tp_seed_rulebooks is replaced from the current seed rows, so new firms
//    get the clean text and the note at version 1.
// 2. Every firm's rulebook whose reference text is still the bank's source
//    text (untouched by a manager) gets the clean text as its next version
//    (version + 1, row_version + 1, updated_by NULL: the system). 109's guard
//    already allows a reference text change at the next version, so no guard
//    is switched off; its history trigger writes the tp_rulebook_versions row.
//    A reference text a manager changed is left as it is (a manager reviews
//    it on the rulebook page). A database created after this change seeds the
//    clean text in 109 already (109 reads the same file), so nothing changes
//    there.
// 3. research_note is filled where it is empty (no new version).
// 4. Automatic conditions of recommendations that are still drafts (draft or
//    changes requested) are recomputed with the clean texts: their
//    description is otherwise fixed (110's tp_conditions_automatic), so that
//    trigger is switched off for this one UPDATE and on again in the same
//    transaction (migrations/run.js runs each file in one transaction).
//    Conditions of recommendations in review or issued are frozen with the
//    recommendation and are not touched.
//
// Questionnaires keep the versions they pinned; from this change the
// automatic condition reads the reference text of the rulebook's current row
// (lib/tprm/rulebooks.js exitPlanRulebooks), so an assessment prepared before
// this migration also gets the clean text in new conditions.

const rulebooks = require('../data/tprm-rulebooks');

const SEED_TAG = '$tp_rulebook_seed$';
const HEAD_END = 'and the date it was last tested or reviewed.';
const CONDITION_MAX = 2000;

function seedFunction(rows) {
  const json = JSON.stringify(rows);
  if (json.includes(SEED_TAG)) throw new Error('the rulebook seed contains its own quote tag');
  return `
ALTER TABLE tp_rulebooks ADD COLUMN IF NOT EXISTS research_note text CHECK (length(research_note) <= 2000);

CREATE OR REPLACE FUNCTION tp_seed_rulebooks(p_firm_id bigint) RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO tp_rulebooks (firm_id, key, position, name, applies_to, status, bank_entry, question_ids, contract_tags,
    exit_plan_required, data_country, reference_text, research_note)
  SELECT p_firm_id, s.key, s.position, s.name, s.applies_to, s.status, s.bank_entry, s.question_ids, s.contract_tags,
    s.exit_plan_required, s.data_country, s.reference_text, s.research_note
  FROM jsonb_to_recordset(${SEED_TAG}${json}${SEED_TAG}::jsonb) AS s(key text, position integer, name text, applies_to text,
    status text, bank_entry jsonb, question_ids jsonb, contract_tags jsonb, exit_plan_required boolean, data_country text,
    reference_text text, research_note text)
  ON CONFLICT (firm_id, key) DO NOTHING;
END;
$fn$;
`;
}

// The automatic condition's "Required ..." sentence for one rulebook, as
// lib/tprm/exit-plans.js conditionText writes it from this migration on.
function requiredSentence(name, reference) {
  const ref = String(reference || '').trim().replace(/\.+$/, '');
  if (!ref) return ` Required by ${name}.`;
  return /^(required|watch list)\b/i.test(ref) ? ` ${ref}.` : ` Required by ${name}: ${ref}.`;
}

// A draft automatic condition with its rulebook sentences recomputed from the
// current reference texts; null when it cannot be read or nothing changes.
function recomputed(description, firmRulebooks) {
  const text = String(description || '');
  const at = text.indexOf(HEAD_END);
  if (at < 0) return null;
  const head = text.slice(0, at + HEAD_END.length);
  const tail = text.slice(at + HEAD_END.length);
  if (!tail.trim()) return null;
  const found = firmRulebooks
    .map(r => ({ r, at: Math.max(tail.indexOf(` ${r.name}:`), tail.indexOf(` ${r.name}.`)) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(x => x.r);
  if (!found.length) return null;
  let next = head + found.map(r => requiredSentence(r.name, r.reference_text)).join('');
  if (next.length > CONDITION_MAX) next = `${next.slice(0, CONDITION_MAX - 3)}...`;
  return next === text ? null : next;
}

async function up(db) {
  const bank = await db.prepare('SELECT content FROM tp_question_bank_versions WHERE version = 1').get();
  if (!bank) throw new Error('migration 112 needs question bank version 1 (migration 099)');
  const content = typeof bank.content === 'string' ? JSON.parse(bank.content) : bank.content;
  const seed = rulebooks.seedRows(content);
  await db.exec(seedFunction(seed));

  const target = JSON.stringify(seed.map(r => ({ key: r.key, reference: r.reference_text, note: r.research_note })));
  // 2. Untouched bank source text -> the clean citation, as the next version.
  await db.prepare(`UPDATE tp_rulebooks r SET reference_text = n.reference, version = r.version + 1, row_version = r.row_version + 1,
      updated_by = NULL, updated_at = now()
    FROM jsonb_to_recordset(?::jsonb) AS n(key text, reference text, note text)
    WHERE r.key = n.key AND r.reference_text IS NOT DISTINCT FROM left(r.bank_entry->>'source', 2000)
      AND r.reference_text IS DISTINCT FROM n.reference`).run(target);
  // 3. The research note where there is none (not a version; nobody has the
  // rulebook form open during a migration, so row_version stays).
  await db.prepare(`UPDATE tp_rulebooks r SET research_note = n.note
    FROM jsonb_to_recordset(?::jsonb) AS n(key text, reference text, note text)
    WHERE r.key = n.key AND r.research_note IS NULL AND n.note IS NOT NULL`).run(target);

  // 4. Draft automatic conditions, recomputed with the current texts.
  const drafts = await db.prepare(`SELECT c.id, c.description, w.firm_id FROM tp_conditions c
      JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id
      JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.automatic AND r.status IN ('draft', 'changes_requested') ORDER BY c.id`).all();
  if (!drafts.length) return;
  const byFirm = new Map();
  const changes = [];
  for (const c of drafts) {
    const firm = Number(c.firm_id);
    if (!byFirm.has(firm)) {
      byFirm.set(firm, await db.prepare('SELECT name, reference_text, position FROM tp_rulebooks WHERE firm_id = ? ORDER BY position')
        .all(firm));
    }
    const next = recomputed(c.description, byFirm.get(firm));
    if (next) changes.push({ id: Number(c.id), description: next });
  }
  if (!changes.length) return;
  await db.exec('ALTER TABLE tp_conditions DISABLE TRIGGER tp_conditions_automatic');
  await db.prepare(`UPDATE tp_conditions c SET description = n.description
    FROM jsonb_to_recordset(?::jsonb) AS n(id bigint, description text)
    WHERE c.id = n.id AND c.automatic`).run(JSON.stringify(changes));
  await db.exec('ALTER TABLE tp_conditions ENABLE TRIGGER tp_conditions_automatic');
}

module.exports = { up, recomputed, requiredSentence };
