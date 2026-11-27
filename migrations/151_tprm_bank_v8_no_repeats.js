'use strict';

const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');

const VERSION = 'Version 8';
const SOURCE_NOTE = 'version 8: a module question that repeats a base question is not asked when the base question is; the base Data Privacy section is called Privacy Programme; '
  + 'ASR-04 is a Yes or No question with a box for what is held, and AIM-18 asks for certificates only if held, so none needs no document; REG-07 is worded so Yes confirms; '
  + 'FTP-03, FTP-05 and RET-03 have a box for each detail their guidance asks for';
const CHANGED = 'Changed in version 8';
const OLD_PRIVACY = 'Data Privacy';
const NEW_PRIVACY = 'Privacy Programme';

const SAME_AS = Object.freeze({
  'CLM-01': ['CLD-02'],
  'CLM-02': ['REG-10'],
  'CLM-03': ['CLD-04'],
  'CLM-04': ['CLD-05'],
  'CLM-11': ['EXT-08'],
  'PRM-02': ['PRV-04'],
  'PRM-04': ['PRV-06'],
  'PRM-05': ['PRV-08'],
  'PRM-06': ['PRV-09', 'FTP-01'],
  'PRM-07': ['APP-06'],
  'PRM-09': ['INC-08'],
});

const changed = (q, note) => Object.assign(q, { status: CHANGED, change_note: note });

const EDITS = [
  bank => {
    const ids = new Set(bank.questions.map(q => q.id));
    let n = 0;
    for (const [id, twins] of Object.entries(SAME_AS)) {
      const q = bank.questions.find(x => x.id === id);
      if (!q || q.set !== 'Module' || q.same_as || !twins.every(t => ids.has(t))) continue;
      q.same_as = [...twins];
      changed(q, `Not asked when ${twins.join(' and ')} ${twins.length === 1 ? 'is' : 'are'} asked, since it repeats ${twins.length === 1 ? 'that question' : 'those questions'}.`);
      n += 1;
    }
    return n;
  },
  bank => {
    if (bank.questions.some(q => q.set === 'Base' && q.domain === NEW_PRIVACY)) return 0;
    let n = 0;
    for (const q of bank.questions) if (q.domain === OLD_PRIVACY) { q.domain = NEW_PRIVACY; n += 1; }
    return n;
  },
  bank => {
    const q = bank.questions.find(x => x.id === 'ASR-04');
    if (!q || q.answer_type !== 'free_text' || q.fields) return 0;
    q.question = 'Do you hold any other current certifications or attestations, such as ISO 27701, ISO 22301, PCI DSS or CSA STAR?';
    q.guidance = 'If you hold none, answer No: nothing more is needed. If Yes, give the scope and expiry of each one and attach the certificates.';
    q.answer_type = 'yes_no_na';
    q.evidence_on = 'yes';
    q.explain_on = ['na'];
    q.details_on_yes = { label: 'Each certification or attestation, with its scope and expiry' };
    changed(q, 'A written list became Yes or No with a box on Yes, so "none" is an honest No that needs no document.');
    return 1;
  },
  bank => {
    const q = bank.questions.find(x => x.id === 'REG-07');
    if (!q || q.answer_type !== 'yes_no_na' || !/^Confirm that you are not owned/.test(String(q.question || ''))) return 0;
    q.question = 'Can you confirm that no director, key managerial personnel or approver of the outsourcing arrangement at <Client>, and none of their relatives, owns or controls you?';
    q.guidance = 'Answer Yes to confirm there is no such relationship. Answer No if there is one, and describe it in the explanation: any exception needs approval under <Client>\'s governance.';
    changed(q, 'Asked as a question that Yes confirms, so Yes and No each mean one thing; the meaning of a Yes or No is unchanged from earlier versions.');
    return 1;
  },
  bank => {
    const q = bank.questions.find(x => x.id === 'AIM-18');
    if (!q || q.answer_type !== 'free_text' || !q.evidence_mandatory) return 0;
    q.evidence_mandatory = false;
    q.evidence = 'Certificates with scope, if you hold any';
    changed(q, 'Certificates are asked for only if held, so None or In progress needs no document.');
    return 1;
  },
  bank => {
    let n = 0;
    for (const [id, label] of [['FTP-03', 'Which obligations are flowed down, and any that are not'], ['FTP-05', 'The notice period in days, and how <Client> can object']]) {
      const q = bank.questions.find(x => x.id === id);
      if (!q || q.answer_type !== 'yes_no_na' || q.details_on_yes || q.fields) continue;
      q.details_on_yes = { label };
      changed(q, 'The details the guidance asks for have a box on Yes.');
      n += 1;
    }
    return n;
  },
  bank => {
    const q = bank.questions.find(x => x.id === 'RET-03');
    if (!q || !Array.isArray(q.fields) || q.fields.some(f => f.key === 'retention')) return 0;
    q.fields.push({ key: 'retention', label: 'How long backups are kept', kind: 'short' });
    changed(q, 'How long backups are kept, asked in the guidance, has its own field.');
    return 1;
  },
];

function apply(content) {
  const bank = JSON.parse(JSON.stringify(content));
  if (!bank || !Array.isArray(bank.questions)) return null;
  const n = EDITS.reduce((sum, edit) => sum + edit(bank), 0);
  if (!n) return null;
  bank.version = VERSION;
  if (!String(bank.source || '').includes(SOURCE_NOTE)) bank.source = bank.source ? `${bank.source}; ${SOURCE_NOTE}` : SOURCE_NOTE;
  return isDeepStrictEqual(bank, content) ? null : bank;
}

async function up(db) {
  const latest = await db.prepare('SELECT content FROM tp_question_bank_versions ORDER BY version DESC LIMIT 1').get();
  if (!latest) return;
  const next = apply(typeof latest.content === 'string' ? JSON.parse(latest.content) : latest.content);
  if (!next) return;
  const raw = `${JSON.stringify(next, null, 1)}\n`;
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  if (await db.prepare('SELECT 1 FROM tp_question_bank_versions WHERE content_sha256 = ?').get(sha)) return;
  const last = await db.prepare('SELECT COALESCE(MAX(version), 0)::int AS v FROM tp_question_bank_versions').get();
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, source, content, content_sha256, question_count)
    VALUES (?, ?, ?, ?::jsonb, ?, ?)`)
    .run(last.v + 1, String(next.version).slice(0, 200), next.source ? String(next.source).slice(0, 1000) : null, raw, sha, next.questions.length);
}

module.exports = { up, apply, SAME_AS };
