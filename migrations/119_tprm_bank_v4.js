'use strict';

// Third-party risk (TPRM): question bank version 4 (product decision, 22 Nov
// 2026; docs/tprm-v2-spec.md section 4k, item 8). Migrations 083-118 are
// applied and frozen; this one only publishes a bank version, as 116 and 118
// did.
//
// data/tprm-question-bank.json now holds version 4:
//   - base and module questions go to every client, so they no longer assume
//     an Indian one: GOV-06, LOG-03, PRM-06, REG-07 and PRV-06 (and the theme
//     of PRV-06 and PRM-04) are worded for any jurisdiction, and the India
//     expectation each carried moves to the firm-only benchmark;
//   - answer hints that did not fit a Yes / No / Not applicable control are
//     fixed: AIM-02, AIM-17, PCI-01 and RBI-02 are reworded so Yes / No / N/A
//     works (AIM-02's contract clause now backs a No, and a Yes is explained);
//     RBI-07 and SEB-04 become written answers; AIM-10's hint fits its "When"
//     question;
//   - UAE-03 no longer names the unverified 4-hour Central Bank timeline; the
//     benchmark keeps it, marked to be verified.
// RBI-02 keeps Yes / No / N/A, so the data-location check (a No is flagged)
// is unchanged.
//
// It is published as the next version unless a row already holds these exact
// bytes: on a database created after this change migrations 099, 116 and 118
// read the same file, so there it is a no-op and the database has one
// version. Questionnaires keep the version they pinned (1, 2 or 3 keep their
// wording, answer types and evidence rules).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BANK_FILE = path.join(__dirname, '..', 'data', 'tprm-question-bank.json');

async function up(db) {
  const raw = fs.readFileSync(BANK_FILE);
  const bank = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(bank.questions) || !bank.questions.length) throw new Error('data/tprm-question-bank.json has no questions');
  if (!bank.questions.every(q => ['yes_no_na', 'free_text'].includes(q.answer_type))) {
    throw new Error('migration 119 publishes a bank whose every question has an answer type');
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
