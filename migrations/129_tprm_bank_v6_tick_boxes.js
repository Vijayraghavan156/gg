'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BANK_FILE = path.join(__dirname, '..', 'data', 'tprm-question-bank.json');

async function up(db) {
  const raw = fs.readFileSync(BANK_FILE);
  const bank = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(bank.questions) || !bank.questions.length) throw new Error('data/tprm-question-bank.json has no questions');
  if (!bank.questions.every(q => ['yes_no_na', 'free_text'].includes(q.answer_type))) {
    throw new Error('migration 129 publishes a bank whose every question has an answer type');
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
