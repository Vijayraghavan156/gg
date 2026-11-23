'use strict';

// Third-party risk (TPRM): question bank version 3 (product decisions, 22 Nov
// 2026; docs/tprm-v2-spec.md section 4k). Migrations 083-117 are applied and
// frozen; this one only publishes a bank version, as 116 did.
//
// data/tprm-question-bank.json now holds version 3:
//   - the module "Cloud & Hosting" is renamed "Hosting Platform & Cloud
//     Provider" (its 12 questions, its module trigger and its 3 conditional
//     contract clauses), to tell it apart from the base domain "Cloud &
//     Hosting Security";
//   - internal notes are out of the text the third party reads (question,
//     guidance, evidence): legal citations, research and status remarks and
//     firm process notes move to the firm-only benchmark, cross-references to
//     other question ids and one verification note are removed, and one typo
//     is fixed. Meaning, ISO 27001 mappings, answer types and evidence rules
//     are unchanged;
//   - report_partly_supported is dropped: nothing reads it since the extra
//     waivers were removed (migration 117).
//
// It is published as the next version unless a row already holds these exact
// bytes: on a database created after this change migrations 099 and 116 read
// the same file, so there it is a no-op and the database has one version.
// Questionnaires keep the version they pinned, and with it their module names
// (lib/tprm/questionnaire-assembly.MODULE_FORMER_NAMES matches a renamed
// module under either name).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BANK_FILE = path.join(__dirname, '..', 'data', 'tprm-question-bank.json');

async function up(db) {
  const raw = fs.readFileSync(BANK_FILE);
  const bank = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(bank.questions) || !bank.questions.length) throw new Error('data/tprm-question-bank.json has no questions');
  if (!bank.questions.every(q => ['yes_no_na', 'free_text'].includes(q.answer_type))) {
    throw new Error('migration 118 publishes a bank whose every question has an answer type');
  }
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  const same = await db.prepare('SELECT version FROM tp_question_bank_versions WHERE content_sha256 = ?').get(sha);
  if (same) return; // published already (a database created after this change: migration 099 read the same file)
  const last = await db.prepare('SELECT COALESCE(MAX(version), 0)::int AS v FROM tp_question_bank_versions').get();
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, source, content, content_sha256, question_count)
    VALUES (?, ?, ?, ?::jsonb, ?, ?)`)
    .run(last.v + 1, String(bank.version || `Version ${last.v + 1}`).slice(0, 200), bank.source ? String(bank.source).slice(0, 1000) : null,
      JSON.stringify(bank), sha, bank.questions.length);
}

module.exports = { up };
