'use strict';

// Third-party risk (TPRM) v2: two contract-tag changes to the rulebooks
// (product decision, 21 Nov 2026; docs/tprm-v2-spec.md sections 4i and 4j).
// Migrations 083-109 are applied and frozen; this one only replaces objects by
// name and updates rows.
//
//   1. Every India-regulated rulebook (the five RBI rulebooks, SEBI CSCRF,
//      SEBI stock exchanges and clearing corporations, IRDAI, PFRDA, IFSCA)
//      also carries "India baseline (CERT-In)", so clause CT-26 is in scope
//      without ticking India baseline separately.
//   2. US - NYDFS Part 500, US - GLBA Safeguards and US - SEC Regulation S-P
//      also carry "Financial-sector (shared)".
//
// The tags come from data/tprm-rulebooks.js (RULEBOOK_TABLE, current values).
// Contract tags never change through the application (109's guard). Here, and
// only here, the guard is switched off for one UPDATE (the 101 pattern): each
// rulebook whose tags differ from the table gets them as its next version
// (version + 1, row_version + 1, updated_by NULL: the system), and 109's
// history trigger, left on, writes the tp_rulebook_versions row, so the
// rulebook's history shows the change. A firm whose rulebook already has the
// tags (a database created after this change: 109 seeds from the same file)
// is left untouched, so this is a no-op there. Questionnaires keep the
// versions they pinned (their pins are snapshots and never change).
//
// tp_seed_rulebooks (109) carries the seed rows as they were when 109 ran; it
// is replaced from the current seed rows, so new firms get the new tags at
// version 1.

const rulebooks = require('../data/tprm-rulebooks');

const SEED_TAG = '$tp_rulebook_seed$';

function seedFunction(rows) {
  const json = JSON.stringify(rows);
  if (json.includes(SEED_TAG)) throw new Error('the rulebook seed contains its own quote tag');
  return `
CREATE OR REPLACE FUNCTION tp_seed_rulebooks(p_firm_id bigint) RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO tp_rulebooks (firm_id, key, position, name, applies_to, status, bank_entry, question_ids, contract_tags,
    exit_plan_required, data_country, reference_text)
  SELECT p_firm_id, s.key, s.position, s.name, s.applies_to, s.status, s.bank_entry, s.question_ids, s.contract_tags,
    s.exit_plan_required, s.data_country, s.reference_text
  FROM jsonb_to_recordset(${SEED_TAG}${json}${SEED_TAG}::jsonb) AS s(key text, position integer, name text, applies_to text,
    status text, bank_entry jsonb, question_ids jsonb, contract_tags jsonb, exit_plan_required boolean, data_country text,
    reference_text text)
  ON CONFLICT (firm_id, key) DO NOTHING;
END;
$fn$;
`;
}

async function up(db) {
  const bank = await db.prepare('SELECT content FROM tp_question_bank_versions WHERE version = 1').get();
  if (!bank) throw new Error('migration 111 needs question bank version 1 (migration 099)');
  const content = typeof bank.content === 'string' ? JSON.parse(bank.content) : bank.content;
  await db.exec(seedFunction(rulebooks.seedRows(content)));
  const target = JSON.stringify(rulebooks.RULEBOOK_TABLE.map(r => ({ key: r.key, tags: [...r.tags] })));
  await db.exec('ALTER TABLE tp_rulebooks DISABLE TRIGGER tp_rulebooks_guard');
  await db.prepare(`UPDATE tp_rulebooks r SET contract_tags = n.tags, version = r.version + 1, row_version = r.row_version + 1,
      updated_by = NULL, updated_at = now()
    FROM jsonb_to_recordset(?::jsonb) AS n(key text, tags jsonb)
    WHERE r.key = n.key AND r.contract_tags IS DISTINCT FROM n.tags`).run(target);
  await db.exec('ALTER TABLE tp_rulebooks ENABLE TRIGGER tp_rulebooks_guard');
}

module.exports = { up };
