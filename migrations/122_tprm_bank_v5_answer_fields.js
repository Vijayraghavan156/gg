'use strict';

// Third-party risk (TPRM): question bank version 5 and named answer fields
// (premium plan Phase 3, docs/tprm-v2-spec.md section 4q). Migrations 083-121
// are applied and frozen.
//
// tp_answers.fields: the named fields of one answer, { key: text }, for a
// version 5 question that has them (a written question split into fields,
// or fields shown on a Yes). The answer's detail keeps a readable copy
// ("Label: value" lines) built by the app, so every reader of detail (the
// firm's review, the AI review, clarifications) is unchanged. NULL for every
// other answer.
//
// data/tprm-question-bank.json now holds version 5: no question asks more
// than one thing per field; answer_type stays yes_no_na or free_text (the
// trigger of migration 116 and migrations 116, 118 and 119 accept only
// those), and the new shapes are extra properties (fields, fields_on,
// details_on_yes, document, acronyms, and a top-level glossary). The
// evidence requests follow Vijay's review of 22 Nov 2026 (no samples, tool
// exports, internal registers or contract clauses; one real document per
// file). It is published as the next version unless a row already holds
// these exact bytes (a database created after this change: migration 099
// read the same file). Questionnaires keep the version they pinned.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BANK_FILE = path.join(__dirname, '..', 'data', 'tprm-question-bank.json');

async function up(db) {
  await db.exec(`
    ALTER TABLE tp_answers ADD COLUMN IF NOT EXISTS fields jsonb;
    ALTER TABLE tp_answers DROP CONSTRAINT IF EXISTS tp_answers_fields_object;
    ALTER TABLE tp_answers ADD CONSTRAINT tp_answers_fields_object CHECK (fields IS NULL OR jsonb_typeof(fields) = 'object');
  `);
  const raw = fs.readFileSync(BANK_FILE);
  const bank = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(bank.questions) || !bank.questions.length) throw new Error('data/tprm-question-bank.json has no questions');
  if (!bank.questions.every(q => ['yes_no_na', 'free_text'].includes(q.answer_type))) {
    throw new Error('migration 122 publishes a bank whose every question has an answer type');
  }
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  const same = await db.prepare('SELECT version FROM tp_question_bank_versions WHERE content_sha256 = ?').get(sha);
  if (same) return;
  const last = await db.prepare('SELECT COALESCE(MAX(version), 0)::int AS v FROM tp_question_bank_versions').get();
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, source, content, content_sha256, question_count)
    VALUES (?, ?, ?, ?::jsonb, ?, ?)`)
    .run(last.v + 1, String(bank.version || `Version ${last.v + 1}`).slice(0, 200), bank.source ? String(bank.source).slice(0, 1000) : null,
      JSON.stringify(bank), sha, bank.questions.length);
}

module.exports = { up };
