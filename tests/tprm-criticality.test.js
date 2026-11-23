'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

let env;
let client;
let db;
let crit;
let firmId;
let manager;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  crit = require('../lib/tprm/criticality');
  firmId = Number((await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id);
  manager = await db.prepare('SELECT * FROM users WHERE email=?').get(env.login.email);
});

test.after(async () => { if (client) await client.close(); });

const clone = value => JSON.parse(JSON.stringify(value));
const starter = () => ({ questions: clone(crit.STARTER_QUESTIONS), intervals: { ...crit.DEFAULT_INTERVALS } });
const starterAnswers = (overrides = {}) => ({
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily', ...overrides,
});

async function newFirm(name) {
  return Number((await db.prepare('INSERT INTO firms (name) VALUES (?)').run(name)).lastInsertRowid);
}

async function firmUser(email, role, firm = firmId) {
  const password = `${role}-password-for-tests-1234`;
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,?,1)`).run(email, bcrypt.hashSync(password, 4), email, firm, role)).lastInsertRowid);
  return { id, email, password, firm_id: firm, firm_role: role, user_type: 'firm' };
}

async function signIn(email, password) {
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${email} signs in`);
  await session.get('/dashboard');
  return session;
}

async function versions(firm = firmId) {
  return await db.prepare('SELECT * FROM tp_criticality_models WHERE firm_id=? ORDER BY version').all(firm);
}

function formBody(model, extra = {}) {
  const body = { row_version: String(model.rowVersion) };
  model.questions.forEach((question, i) => {
    body[`questions[${i}][id]`] = question.id;
    body[`questions[${i}][kind]`] = question.kind;
    body[`questions[${i}][text]`] = question.text;
    question.answers.forEach((answer, j) => {
      body[`questions[${i}][answers][${j}][id]`] = answer.id;
      body[`questions[${i}][answers][${j}][label]`] = answer.label;
      body[`questions[${i}][answers][${j}][tier]`] = answer.tier;
    });
  });
  for (const tier of crit.TIERS) body[`interval_${tier.toLowerCase()}`] = String(model.intervals[tier]);
  return { ...body, ...extra };
}

async function discardAnyDraft(firm = firmId) {
  await db.prepare(`DELETE FROM tp_criticality_models WHERE firm_id=? AND status='draft'`).run(firm);
}

test('every firm starts with the starter model as active version 1, and it is valid', async () => {
  const rows = await versions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 1);
  assert.equal(rows[0].status, 'active');
  assert.ok(rows[0].activated_at, 'the starter version is recorded as activated');
  assert.deepEqual(rows[0].questions, clone(crit.STARTER_QUESTIONS), 'the SQL seed and STARTER_QUESTIONS are identical');
  assert.deepEqual(
    [rows[0].interval_months_critical, rows[0].interval_months_high, rows[0].interval_months_medium, rows[0].interval_months_low],
    [12, 12, 24, 36]);
  const model = await crit.getActiveModel(db, firmId);
  assert.deepEqual(crit.validateModel(model), []);
  assert.equal(model.questions.length, 9);
  assert.equal(model.questions.filter(q => q.kind === 'criticality').length, 5);
  assert.equal(model.questions.filter(q => q.kind === 'service_description').length, 4);
  const software = model.questions.find(q => q.id === 'supplies_software');
  assert.deepEqual(software && software.answers.map(a => [a.id, a.label, a.tier]), [['no', 'No', 'Low'], ['yes', 'Yes', 'Low']]);
});

test('a new firm gets the starter model; the backfill seeds existing firms once', async () => {
  const fresh = await newFirm('Fresh Criticality Firm');
  const rows = await versions(fresh);
  assert.equal(rows.length, 1, 'firm creation seeds the starter model');
  assert.equal(rows[0].status, 'active');
  assert.deepEqual(rows[0].questions, clone(crit.STARTER_QUESTIONS));

  await db.exec('ALTER TABLE firms DISABLE TRIGGER tp_firms_seed_criticality');
  let legacy;
  try {
    legacy = await newFirm('Pre-existing Criticality Firm');
  } finally {
    await db.exec('ALTER TABLE firms ENABLE TRIGGER tp_firms_seed_criticality');
  }
  assert.equal((await versions(legacy)).length, 0);
  await db.prepare('SELECT tp_seed_starter_criticality_model(id) FROM firms').all();
  await db.prepare('SELECT tp_seed_starter_criticality_model(id) FROM firms').all();
  const seeded = await versions(legacy);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].status, 'active');
  assert.equal((await versions()).length, 1, 'firms that already have a model are untouched');
  const counts = await db.prepare(`SELECT f.id, COUNT(m.id) FILTER (WHERE m.status='active') AS active
    FROM firms f LEFT JOIN tp_criticality_models m ON m.firm_id=f.id GROUP BY f.id`).all();
  assert.ok(counts.every(r => Number(r.active) === 1), 'every firm has exactly one active version');
});

test('migration 093: the starter says "third party"; only untouched starter models are reworded', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const migrations = path.join(__dirname, '..', 'migrations');
  const jsonOf = file => JSON.parse(fs.readFileSync(path.join(migrations, file), 'utf8').match(/\$json\$(\[[\s\S]*?\])\$json\$/)[1]);
  const old092 = jsonOf('092_tprm_criticality_models.sql');
  const sql093 = fs.readFileSync(path.join(migrations, '093_tprm_starter_wording.sql'), 'utf8');
  const sql101 = fs.readFileSync(path.join(migrations, '101_tprm_supplies_software.sql'), 'utf8');
  const blocks = [...sql093.matchAll(/\$json\$(\[[\s\S]*?\])\$json\$/g)].map(m => JSON.parse(m[1]));
  const post093 = clone(crit.STARTER_QUESTIONS).filter(q => q.id !== 'supplies_software');
  assert.equal(blocks.length, 3, 'the seed function, the new wording and the old-starter guard');
  assert.deepEqual(blocks[0], post093, 'the reworded seed matches STARTER_QUESTIONS (without the 101 question)');
  assert.deepEqual(blocks[1], post093);
  assert.deepEqual(blocks[2], old092, 'the guard compares against the exact 092 starter');
  assert.doesNotMatch(JSON.stringify(crit.STARTER_QUESTIONS.map(q => [q.text, q.answers.map(a => a.label)])), /vendor/i);
  const ids = list => list.map(q => [q.id, q.answers.map(a => a.id)]);
  assert.deepEqual(ids(post093), ids(old092), 'question and answer ids are unchanged');

  const setQuestions = async (firm, questions) => {
    await db.transaction(async () => {
      await db.exec('ALTER TABLE tp_criticality_models DISABLE TRIGGER tp_criticality_models_guard');
      await db.prepare('UPDATE tp_criticality_models SET questions=?::jsonb WHERE firm_id=? AND version=1').run(JSON.stringify(questions), firm);
      await db.exec('ALTER TABLE tp_criticality_models ENABLE TRIGGER tp_criticality_models_guard');
    })();
  };
  const untouched = await newFirm('Old Starter Firm');
  const edited = await newFirm('Edited Starter Firm');
  const withDraft = await newFirm('Starter With Draft Firm');
  await setQuestions(untouched, old092);
  const editedQuestions = clone(old092);
  editedQuestions[0].answers[0].label = 'No data at all';
  await setQuestions(edited, editedQuestions);
  await setQuestions(withDraft, old092);
  await db.prepare(`INSERT INTO tp_criticality_models (firm_id, version, status, questions) VALUES (?, 2, 'draft', ?::jsonb)`)
    .run(withDraft, JSON.stringify(old092));

  await db.transaction(async () => { await db.exec(sql093); })();
  await db.transaction(async () => { await db.exec(sql101); })();

  assert.deepEqual((await versions(untouched))[0].questions, clone(crit.STARTER_QUESTIONS),
    'the untouched starter is reworded, then gains the 101 question');
  assert.equal((await versions(untouched))[0].status, 'active');
  assert.deepEqual((await versions(edited))[0].questions, editedQuestions, 'an edited model is left alone');
  const draftFirm = await versions(withDraft);
  assert.deepEqual(draftFirm.map(v => v.questions), [old092, old092], 'a firm with another version is left alone');
  await assert.rejects(db.prepare(`UPDATE tp_criticality_models SET questions=questions WHERE firm_id=? AND version=1`).run(untouched),
    /immutable/, 'the guard is back on after the migration');
  await discardAnyDraft(withDraft);
});

test('migration 101: the starter gains supplies_software; only untouched starter models get it', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sql101 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '101_tprm_supplies_software.sql'), 'utf8');
  const blocks = [...sql101.matchAll(/\$json\$(\[[\s\S]*?\])\$json\$/g)].map(m => JSON.parse(m[1]));
  const post093 = clone(crit.STARTER_QUESTIONS).filter(q => q.id !== 'supplies_software');
  assert.equal(blocks.length, 3, 'the seed function, the new value and the post-093 guard');
  assert.deepEqual(blocks[0], clone(crit.STARTER_QUESTIONS), 'the seed matches STARTER_QUESTIONS');
  assert.deepEqual(blocks[1], clone(crit.STARTER_QUESTIONS));
  assert.deepEqual(blocks[2], post093, 'the guard compares against the exact starter as 093 left it');
  assert.equal(crit.STARTER_QUESTIONS[crit.STARTER_QUESTIONS.length - 1].id, 'supplies_software', 'the new question comes last');

  const setQuestions = async (firm, questions) => {
    await db.transaction(async () => {
      await db.exec('ALTER TABLE tp_criticality_models DISABLE TRIGGER tp_criticality_models_guard');
      await db.prepare('UPDATE tp_criticality_models SET questions=?::jsonb WHERE firm_id=? AND version=1').run(JSON.stringify(questions), firm);
      await db.exec('ALTER TABLE tp_criticality_models ENABLE TRIGGER tp_criticality_models_guard');
    })();
  };
  const untouched = await newFirm('Post-093 Starter Firm');
  const edited = await newFirm('Edited Post-093 Firm');
  const withDraft = await newFirm('Post-093 With Draft Firm');
  const current = await newFirm('Current Starter Firm');
  await setQuestions(untouched, post093);
  const editedQuestions = clone(post093);
  editedQuestions[4].answers[2].label = 'Only one supplier exists';
  await setQuestions(edited, editedQuestions);
  await setQuestions(withDraft, post093);
  await db.prepare(`INSERT INTO tp_criticality_models (firm_id, version, status, questions) VALUES (?, 2, 'draft', ?::jsonb)`)
    .run(withDraft, JSON.stringify(post093));
  const before = await versions(untouched);

  await db.transaction(async () => { await db.exec(sql101); })();
  await db.transaction(async () => { await db.exec(sql101); })();

  const after = await versions(untouched);
  assert.deepEqual(after[0].questions, clone(crit.STARTER_QUESTIONS), 'the untouched starter gains the question');
  assert.equal(after[0].status, 'active');
  assert.equal(after[0].row_version, before[0].row_version + 1, 'applied once: running it again changes nothing');
  assert.deepEqual((await versions(edited))[0].questions, editedQuestions, 'an edited model is left alone');
  assert.deepEqual((await versions(withDraft)).map(v => v.questions), [post093, post093], 'a firm with another version is left alone');
  assert.deepEqual((await versions(current))[0].questions, clone(crit.STARTER_QUESTIONS));
  assert.deepEqual((await versions(await newFirm('Firm After 101')))[0].questions, clone(crit.STARTER_QUESTIONS),
    'a new firm gets the nine questions');
  await assert.rejects(db.prepare(`UPDATE tp_criticality_models SET questions=questions WHERE firm_id=? AND version=1`).run(untouched),
    /immutable/, 'the guard is back on after the migration');
  assert.equal(crit.scoreTier(starter(), starterAnswers({ supplies_software: 'yes' })).tier, 'low');
  await discardAnyDraft(withDraft);
});

test('scoring: the highest answer wins and names the answer that set it', () => {
  const model = starter();
  const low = crit.scoreTier(model, starterAnswers());
  assert.equal(low.tier, 'low', 'the tier comes back in the storage form');
  assert.equal(low.tierLabel, 'Low');
  assert.equal(low.explanation, 'Low because: None');

  const critical = crit.scoreTier(model, starterAnswers({ data_handled: 'special_financial', system_access: 'privileged' }));
  assert.equal(critical.tier, 'critical');
  assert.equal(critical.explanation, 'Critical because: Special-category, financial or payment data');
  assert.equal(critical.decidingQuestion.id, 'data_handled');
  assert.equal(critical.decidingAnswer.id, 'special_financial');
  assert.equal(critical.decidingAnswer.tier, 'critical');

  const high = crit.scoreTier(model, starterAnswers({ data_handled: 'internal', system_access: 'user', replaceability: 'sole_source' }));
  assert.equal(high.tier, 'high');
  assert.equal(high.explanation, 'High because: Sole source');

  const tie = crit.scoreTier(model, starterAnswers({ data_handled: 'personal', regulated: 'yes' }));
  assert.equal(tie.tier, 'high');
  assert.equal(tie.decidingQuestion.id, 'data_handled');

  const answers = new Map(Object.entries(starterAnswers({ service_stops: 'key_process_stops' })));
  assert.equal(crit.scoreTier(model, answers).explanation, 'Critical because: A key process stops');
});

test('scoring: service-description questions never raise the tier', () => {
  const model = starter();
  const result = crit.scoreTier(model, starterAnswers({
    delivery_model: 'staff_onsite', payments_records: 'yes', sites_data: 'yes',
  }));
  assert.equal(result.tier, 'low');
  assert.notEqual(result.decidingQuestion.id, 'payments_records');

  const tampered = starter();
  tampered.questions.find(q => q.id === 'payments_records').answers[1].tier = 'Critical';
  assert.equal(crit.scoreTier(tampered, starterAnswers({ payments_records: 'yes' })).tier, 'low');
  assert.ok(crit.validateModel(tampered).some(e => /service-description answers are always Low/.test(e)));
});

test('scoring: an unanswered criticality question or an unknown answer is an error', () => {
  const model = starter();
  const partial = starterAnswers();
  delete partial.regulated;
  delete partial.replaceability;
  assert.throws(() => crit.scoreTier(model, partial), err => err instanceof crit.CriticalityError
    && err.code === 'unanswered' && err.missing.join() === 'regulated,replaceability');
  assert.throws(() => crit.scoreTier(model, {}), err => err.code === 'unanswered' && err.missing.length === 5);
  assert.throws(() => crit.scoreTier(model, starterAnswers({ data_handled: 'everything' })), err => err.code === 'unknown_answer');
  assert.equal(crit.scoreTier(model, starterAnswers()).tier, 'low');
});

test('intervalFor: firm defaults per tier, overridden per client', () => {
  const model = starter();
  assert.deepEqual(crit.TIER_KEYS.map(t => crit.intervalFor(model, t)), [12, 12, 24, 36]);
  assert.deepEqual(crit.TIERS.map(t => crit.intervalFor(model, t)), [36, 24, 12, 12], 'display labels are still accepted');
  const settingsRow = { interval_months_critical: 6, interval_months_high: null, interval_months_medium: 18, interval_months_low: null };
  assert.equal(crit.intervalFor(model, 'critical', settingsRow), 6);
  assert.equal(crit.intervalFor(model, 'high', settingsRow), 12, 'no client override: the firm default');
  assert.equal(crit.intervalFor(model, 'Medium', settingsRow), 18);
  assert.equal(crit.intervalFor(model, 'low', { Low: 48 }), 48);
  assert.equal(crit.intervalFor(model, 'low', { low: 0 }), 36, 'an invalid override is ignored');
  assert.throws(() => crit.intervalFor(model, 'Severe'), err => err.code === 'bad_tier');
  assert.deepEqual(crit.intervalsFor(model, settingsRow), { critical: 6, high: 12, medium: 18, low: 36 });
});

test('tier names: criticality.js and the register (placement, migration 091) agree on one storage form', () => {
  const placement = require('../lib/tprm/placement');
  assert.deepEqual([...crit.TIER_KEYS].sort(), [...placement.TIERS].sort(), 'the same four storage keys');
  for (const key of placement.TIERS) {
    assert.equal(crit.toTierKey(key), key);
    assert.equal(crit.toTierKey(crit.tierLabel(key)), key, `${key} round-trips through its label`);
    assert.equal(crit.tierLabel(key), placement.TIER_LABELS[key], 'and the labels match the register\'s');
    assert.ok(Number.isInteger(crit.intervalFor(starter(), key)));
  }
  assert.equal(crit.toTierKey('Severe'), null);
  const model = starter();
  for (const answers of [starterAnswers(), starterAnswers({ data_handled: 'internal' }),
    starterAnswers({ regulated: 'yes' }), starterAnswers({ service_stops: 'key_process_stops' })]) {
    const { tier } = crit.scoreTier(model, answers);
    assert.ok(placement.isTier(tier), `${tier} is a register tier`);
  }
  assert.deepEqual(Object.keys(crit.intervalsFor(model)).sort(), [...placement.TIERS].sort(),
    'the model intervals feed placement.intervalsFor directly');
  assert.deepEqual(placement.intervalsFor({}, crit.intervalsFor(model)), { critical: 12, high: 12, medium: 24, low: 36 });
});

test('firmIntervals: the active model\'s intervals; a firm with no active model falls back and is logged', async () => {
  const active = await crit.getActiveModel(db, firmId);
  const result = await crit.firmIntervals(db, firmId);
  assert.equal(result.fallback, false);
  assert.equal(result.version, active.version);
  assert.deepEqual(result.intervals, crit.intervalsFor(active));
  const warnings = [];
  const missing = await crit.firmIntervals(db, 987654321, { logger: { warn: m => warnings.push(m) } });
  assert.equal(missing.fallback, true);
  assert.deepEqual(missing.intervals, { critical: 12, high: 12, medium: 24, low: 36 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no active criticality model/);
});

test('validation rejects bad drafts', () => {
  const problems = mutate => { const model = starter(); mutate(model); return crit.validateModel(model); };
  assert.deepEqual(crit.validateModel(starter()), []);
  assert.ok(problems(m => { m.questions = m.questions.filter(q => q.kind !== 'criticality'); })
    .some(e => /at least one criticality question/.test(e)));
  assert.ok(problems(m => { m.questions[3].answers = m.questions[3].answers.slice(0, 1); })
    .some(e => /Question 4 needs at least two answers/.test(e)));
  assert.ok(problems(m => { m.questions[0].answers[2].tier = ''; }).some(e => /answer 3 needs a tier/.test(e)));
  assert.ok(problems(m => { m.questions[0].answers[2].tier = 'Severe'; }).some(e => /needs a tier/.test(e)));
  assert.ok(problems(m => { delete m.questions[1].answers[0].tier; }).some(e => /needs a tier/.test(e)));
  assert.ok(problems(m => { m.questions[6].answers[1].tier = 'High'; }).some(e => /service-description answers are always Low/.test(e)));
  assert.ok(problems(m => { m.questions[2].id = m.questions[0].id; }).some(e => /question ids must be unique/.test(e)));
  assert.ok(problems(m => { m.questions[0].answers[1].id = 'none'; }).some(e => /answer ids must be unique/.test(e)));
  assert.ok(problems(m => { m.questions[0].text = '  '; }).some(e => /needs its question text/.test(e)));
  assert.ok(problems(m => { m.questions[0].answers[0].label = ''; }).some(e => /needs its wording/.test(e)));
  assert.ok(problems(m => { m.intervals.Medium = 0; }).some(e => /Medium reassessment interval/.test(e)));
  assert.ok(problems(m => { m.intervals.Low = 121; }).some(e => /Low reassessment interval/.test(e)));
  assert.ok(problems(m => { m.questions[0].kind = 'points'; }).some(e => /criticality or a service-description/.test(e)));
});

test('the editor refuses edits that would break the model', () => {
  const model = starter();
  const onlyOne = { ...model, questions: [model.questions[0], model.questions[5]] };
  assert.match(crit.applyEdit(onlyOne, 'delete_question:0').error, /at least one criticality question/);
  assert.match(crit.applyEdit(model, 'delete_answer:3:0').error, /needs at least two answers/);
  const added = crit.applyEdit(model, 'add_question').model;
  assert.equal(added.questions.length, 10);
  assert.deepEqual(crit.validateModel(added), [], 'a new question starts valid');
  const moved = crit.applyEdit(model, 'move_up:1').model;
  assert.deepEqual(moved.questions.slice(0, 2).map(q => q.id), ['service_stops', 'data_handled']);
  assert.equal(model.questions[0].id, 'data_handled', 'edits do not mutate their input');
});

test('a manager creates a draft, edits an answer\'s tier, saves, and activates it', async () => {
  const page = await client.get('/tprm/settings/criticality');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-active-version="1"/);
  assert.match(page.text, /data-tprm-scoring-example/, 'the scoring explainer is shown');
  assert.match(page.text, /data-tprm-new-version/);
  assert.doesNotMatch(page.text, /data-tprm-criticality-readonly/, "managers keep the editor");
  assert.match(page.text, /data-tprm-version-history/);
  assert.match((await client.get('/tprm')).text, /href="\/tprm\/settings\/criticality"/, 'the /tprm page links to the editor');

  const created = await client.post('/tprm/settings/criticality/drafts', {});
  assert.equal(created.status, 302);
  const draftId = Number(created.location.match(/versions\/(\d+)/)[1]);
  let draft = await crit.getVersion(db, firmId, draftId);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.version, 2);
  assert.deepEqual(draft.questions, clone(crit.STARTER_QUESTIONS), 'the draft is copied from the active version');
  assert.equal(draft.createdBy, Number(manager.id));

  const again = await client.post('/tprm/settings/criticality/drafts', {});
  assert.equal(Number(again.location.match(/versions\/(\d+)/)[1]), draftId, 'one draft at a time');
  assert.equal((await versions()).length, 2);

  const edit = await client.get(`/tprm/settings/criticality/versions/${draftId}`);
  assert.equal(edit.status, 200);
  assert.match(edit.text, /data-tprm-draft-form/);
  assert.match(edit.text, /name="_csrf" value="[a-f0-9]+"/);

  const changed = clone(draft);
  changed.questions[2].answers[1].tier = 'High';
  changed.questions[0].text = 'What data will the third party handle or see?';
  changed.intervals.Medium = 18;
  const saved = await client.post(`/tprm/settings/criticality/versions/${draftId}`, formBody(changed, { op: 'save' }));
  assert.equal(saved.status, 302, saved.text);
  draft = await crit.getVersion(db, firmId, draftId);
  assert.equal(draft.questions[2].answers[1].tier, 'High');
  assert.equal(draft.questions[0].text, 'What data will the third party handle or see?');
  assert.equal(draft.intervals.Medium, 18);
  assert.equal(draft.rowVersion, 2);

  const added = await client.post(`/tprm/settings/criticality/versions/${draftId}`, formBody(draft, { op: 'add_question' }));
  assert.equal(added.status, 302);
  draft = await crit.getVersion(db, firmId, draftId);
  assert.equal(draft.questions.length, 10);
  const removed = await client.post(`/tprm/settings/criticality/versions/${draftId}`, formBody(draft, { op: 'delete_question:9' }));
  assert.equal(removed.status, 302);
  draft = await crit.getVersion(db, firmId, draftId);
  assert.equal(draft.questions.length, 9);
  const toReview = await client.post(`/tprm/settings/criticality/versions/${draftId}`, formBody(draft, { op: 'review' }));
  assert.equal(toReview.status, 302);
  assert.equal(decodeURIComponent(toReview.location), `/tprm/settings/criticality/versions/${draftId}/activate?toast=Draft saved`);
  draft = await crit.getVersion(db, firmId, draftId);

  const review = await client.get(`/tprm/settings/criticality/versions/${draftId}/activate`);
  assert.equal(review.status, 200);
  assert.match(review.text, /User-level&#34; Medium → High|User-level" Medium → High/);
  assert.match(review.text, /Medium reassessment interval: 24 → 18 months/);

  const activated = await client.post(`/tprm/settings/criticality/versions/${draftId}/activate`, { row_version: String(draft.rowVersion) });
  assert.equal(activated.status, 302);
  const rows = await versions();
  assert.deepEqual(rows.map(r => [r.version, r.status]), [[1, 'retired'], [2, 'active']]);
  assert.equal(Number(rows[1].activated_by), Number(manager.id));
  assert.ok(rows[1].activated_at);
  assert.equal(Number(rows[0].retired_by), Number(manager.id));
  assert.ok(rows[0].retired_at);
  assert.ok(await db.prepare(`SELECT 1 FROM audit_log WHERE action='tprm_criticality_version_activated' AND entity_id=?`).get(String(draftId)));

  const active = await crit.getActiveModel(db, firmId);
  assert.equal(active.version, 2);
  assert.equal(crit.scoreTier(active, starterAnswers({ system_access: 'user' })).explanation, 'High because: User-level');

  const history = await client.get('/tprm/settings/criticality');
  assert.match(history.text, /data-version-row="1"/);
  assert.match(history.text, /data-version-row="2"/);
  const retired = await client.get(`/tprm/settings/criticality/versions/${rows[0].id}`);
  assert.equal(retired.status, 200);
  assert.doesNotMatch(retired.text, /data-tprm-draft-form/, 'a retired version is read-only');
  const refused = await client.post(`/tprm/settings/criticality/versions/${rows[0].id}`, formBody({ ...starter(), rowVersion: 1 }, { op: 'save' }));
  assert.equal(refused.status, 302, 'saving a retired version is refused');
  assert.match(refused.location, /&toastKind=error$/, 'the refusal is shown as an error');
  assert.deepEqual((await crit.getVersion(db, firmId, rows[0].id)).questions, clone(crit.STARTER_QUESTIONS));
});

test('an invalid draft is not saved and cannot be activated; a stale save is refused', async () => {
  await discardAnyDraft();
  const { model: draft } = await crit.createDraft(db, manager);
  const bad = clone(draft);
  bad.questions[0].answers[0].label = '';
  const res = await client.post(`/tprm/settings/criticality/versions/${draft.id}`, formBody(bad, { op: 'save' }));
  assert.equal(res.status, 400);
  assert.match(res.text, /Not saved/);
  assert.match(res.text, /needs its wording/);
  assert.deepEqual((await crit.getVersion(db, firmId, draft.id)).questions, draft.questions, 'nothing was saved');

  const lastAnswer = clone(draft);
  const r2 = await client.post(`/tprm/settings/criticality/versions/${draft.id}`, formBody(lastAnswer, { op: 'delete_answer:3:1' }));
  assert.equal(r2.status, 400);
  assert.match(r2.text, /needs at least two answers/);

  await assert.rejects(crit.saveDraft(db, manager, draft.id, { ...bad, rowVersion: draft.rowVersion }), err => err.code === 'invalid');
  await db.prepare(`UPDATE tp_criticality_models SET questions=jsonb_set(questions, '{0,answers,0,label}', '""') WHERE id=?`).run(draft.id);
  await assert.rejects(crit.activateDraft(db, manager, draft.id), err => err.code === 'invalid');
  const review = await client.get(`/tprm/settings/criticality/versions/${draft.id}/activate`);
  assert.match(review.text, /cannot be activated yet/);
  assert.match(review.text, /type="submit" data-tprm-activate disabled/);
  assert.equal((await crit.getActiveModel(db, firmId)).version, 2);

  await assert.rejects(db.prepare(`UPDATE tp_criticality_models SET questions=jsonb_set(questions, '{0,answers,0,tier}', '"Severe"') WHERE id=?`).run(draft.id),
    /check constraint|tp_criticality_questions_ok|violates/i);
  await assert.rejects(db.prepare(`UPDATE tp_criticality_models SET questions=questions #- '{0,answers,0,tier}' WHERE id=?`).run(draft.id),
    /check constraint|violates/i, 'an answer with no tier at all is refused');
  await assert.rejects(db.prepare(`UPDATE tp_criticality_models SET questions=jsonb_set(questions, '{0,answers,0,tier}', 'null') WHERE id=?`).run(draft.id),
    /check constraint|violates/i, 'a null tier is refused');
  await assert.rejects(db.prepare(`UPDATE tp_criticality_models SET questions=questions #- '{0,kind}' WHERE id=?`).run(draft.id),
    /check constraint|violates/i, 'a question with no kind is refused');

  const current = await crit.getVersion(db, firmId, draft.id);
  const stale = await client.post(`/tprm/settings/criticality/versions/${draft.id}`, formBody({ ...clone(current), rowVersion: current.rowVersion - 1 }, { op: 'save' }));
  assert.equal(stale.status, 409, 'a stale row_version is refused');
  assert.match(stale.text, /Someone else changed this draft/);
  await assert.rejects(crit.activateDraft(db, manager, draft.id, { rowVersion: current.rowVersion + 5 }), err => err.code === 'stale');

  const discard = await client.post(`/tprm/settings/criticality/versions/${draft.id}/discard`, { row_version: String(current.rowVersion) });
  assert.equal(discard.status, 302);
  assert.equal(await crit.getVersion(db, firmId, draft.id), null);
});

test('a draft with more than 20 questions saves every question in order', async () => {
  await discardAnyDraft();
  const { model: draft } = await crit.createDraft(db, manager);
  const big = clone(draft);
  while (big.questions.length < 22) {
    const n = big.questions.length + 1;
    big.questions.push({ id: `q_extra_${n}`, kind: 'criticality', text: `Extra question ${n}`,
      answers: [{ id: 'a1', label: 'One', tier: 'Low' }, { id: 'a2', label: 'Two', tier: n === 22 ? 'Critical' : 'Medium' }] });
  }
  const res = await client.post(`/tprm/settings/criticality/versions/${draft.id}`, formBody(big, { op: 'save' }));
  assert.equal(res.status, 302, res.text);
  const saved = await crit.getVersion(db, firmId, draft.id);
  assert.deepEqual(saved.questions.map(q => q.id), big.questions.map(q => q.id));
  assert.equal(saved.questions[21].answers[1].tier, 'Critical');
  await crit.discardDraft(db, manager, draft.id);
});

test('only managers can edit or activate the model; consultants and senior consultants get the active version read-only', async () => {
  await discardAnyDraft();
  const { model: draft } = await crit.createDraft(db, manager);
  const marker = 'Draft-only wording that must not leak';
  const changed = clone(draft.questions);
  changed[0].text = marker;
  const savedDraft = await crit.saveDraft(db, manager, draft.id, { questions: changed, intervals: draft.intervals, rowVersion: draft.rowVersion });
  const active = await crit.getActiveModel(db, firmId);
  for (const role of ['consultant', 'senior_consultant']) {
    const user = await firmUser(`criticality-${role}@test.local`, role);
    const session = await signIn(user.email, user.password);
    try {
      const view = await session.get('/tprm/settings/criticality');
      assert.equal(view.status, 200, `${role}: reads the model`);
      assert.match(view.text, /data-tprm-criticality-readonly/);
      assert.match(view.text, new RegExp(`data-tprm-active-version="${active.version}"`), 'the active version is shown');
      assert.ok(view.text.includes(active.questions[0].text.replace(/'/g, '&#39;')) || view.text.includes(active.questions[0].text));
      assert.doesNotMatch(view.text, /data-tprm-new-version|data-tprm-continue-draft|data-tprm-version-history|action="\/tprm\/settings/,
        `${role}: no edit actions and no version history`);
      assert.doesNotMatch(view.text, new RegExp(marker), `${role}: the draft does not leak`);
      assert.doesNotMatch(view.text, /href="\/tprm\/settings\/criticality\/versions/);
      assert.equal((await session.get(`/tprm/settings/criticality/versions/${draft.id}`)).status, 403);
      assert.equal((await session.get(`/tprm/settings/criticality/versions/${active.id}`)).status, 403, 'version pages stay manager-only');
      assert.equal((await session.post('/tprm/settings/criticality/drafts', {})).status, 403, `${role}: new version`);
      assert.equal((await session.post(`/tprm/settings/criticality/versions/${draft.id}`, formBody(savedDraft, { op: 'save' }))).status, 403);
      assert.equal((await session.post(`/tprm/settings/criticality/versions/${draft.id}/activate`, { row_version: String(savedDraft.rowVersion) })).status, 403);
      assert.equal((await session.post(`/tprm/settings/criticality/versions/${draft.id}/discard`, {})).status, 403);
      assert.match((await session.get('/tprm')).text, /href="\/tprm\/settings\/criticality"/, `${role}: the read-only page is linked`);
    } finally {
      await session.close();
    }
    await assert.rejects(crit.createDraft(db, user), err => err.code === 'forbidden');
    await assert.rejects(crit.saveDraft(db, user, draft.id, { ...draft }), err => err.code === 'forbidden');
    await assert.rejects(crit.activateDraft(db, user, draft.id), err => err.code === 'forbidden');
  }
  const clientUser = { id: 1, user_type: 'client', firm_id: firmId, firm_role: 'manager' };
  await assert.rejects(crit.activateDraft(db, clientUser, draft.id), err => err.code === 'forbidden');
  assert.equal((await crit.getVersion(db, firmId, draft.id)).status, 'draft');
});

test('active and retired versions are immutable in the database; one active version per firm', async () => {
  const [retired, active] = (await versions()).filter(r => r.status !== 'draft');
  assert.equal(retired.status, 'retired');
  assert.equal(active.status, 'active');
  const rejects = (sql, ...params) => assert.rejects(db.prepare(sql).run(...params), /immutable|cannot be deleted|cannot change|only be activated/);

  await rejects(`UPDATE tp_criticality_models SET questions='[]'::jsonb WHERE id=?`, active.id);
  await rejects(`UPDATE tp_criticality_models SET interval_months_low=48 WHERE id=?`, active.id);
  await rejects(`UPDATE tp_criticality_models SET questions=jsonb_set(questions, '{0,text}', '"Changed"') WHERE id=?`, active.id);
  await rejects(`UPDATE tp_criticality_models SET status='draft' WHERE id=?`, active.id);
  await rejects(`UPDATE tp_criticality_models SET status='active' WHERE id=?`, retired.id);
  await rejects(`UPDATE tp_criticality_models SET questions=jsonb_set(questions, '{0,text}', '"Changed"') WHERE id=?`, retired.id);
  await rejects(`UPDATE tp_criticality_models SET version=9 WHERE id=?`, active.id);
  await rejects('DELETE FROM tp_criticality_models WHERE id=?', active.id);
  await rejects('DELETE FROM tp_criticality_models WHERE id=?', retired.id);

  const draft = (await versions()).find(r => r.status === 'draft');
  assert.ok(draft, 'a draft from the previous test');
  await assert.rejects(db.prepare(`UPDATE tp_criticality_models SET status='retired', retired_at=now() WHERE id=?`).run(draft.id), /only be activated/);
  await assert.rejects(db.prepare(`UPDATE tp_criticality_models SET status='active', activated_at=now() WHERE id=?`).run(draft.id),
    /duplicate key|tp_criticality_models_one_active/, 'a second active version is refused');
  await assert.rejects(db.prepare(`INSERT INTO tp_criticality_models (firm_id, version, status, questions) VALUES (?, 99, 'draft', ?::jsonb)`)
    .run(firmId, JSON.stringify(crit.STARTER_QUESTIONS)), /duplicate key|tp_criticality_models_one_draft/, 'a second draft is refused');
  const actives = await db.prepare(`SELECT COUNT(*) AS c FROM tp_criticality_models WHERE firm_id=? AND status='active'`).get(firmId);
  assert.equal(Number(actives.c), 1);
});

test('another firm\'s model is a 404 and is never changed', async () => {
  const otherFirm = await newFirm('Other Criticality Firm');
  const otherManager = await firmUser('criticality-other-manager@test.local', 'manager', otherFirm);
  const { model: foreignDraft } = await crit.createDraft(db, otherManager);
  const foreignActive = await crit.getActiveModel(db, otherFirm);

  assert.equal((await client.get(`/tprm/settings/criticality/versions/${foreignActive.id}`)).status, 404);
  assert.equal((await client.get(`/tprm/settings/criticality/versions/${foreignDraft.id}`)).status, 404);
  assert.equal((await client.get(`/tprm/settings/criticality/versions/${foreignDraft.id}/activate`)).status, 404);
  const changed = clone(foreignDraft);
  changed.questions[0].answers[0].tier = 'Critical';
  assert.equal((await client.post(`/tprm/settings/criticality/versions/${foreignDraft.id}`, formBody(changed, { op: 'save' }))).status, 404);
  assert.equal((await client.post(`/tprm/settings/criticality/versions/${foreignDraft.id}/activate`, { row_version: String(foreignDraft.rowVersion) })).status, 404);
  assert.equal((await client.post(`/tprm/settings/criticality/versions/${foreignDraft.id}/discard`, { row_version: String(foreignDraft.rowVersion) })).status, 404);
  assert.equal((await client.get('/tprm/settings/criticality/versions/not-a-number')).status, 404);
  await assert.rejects(crit.activateDraft(db, manager, foreignDraft.id), err => err.code === 'not_found');

  const page = await client.get('/tprm/settings/criticality');
  assert.doesNotMatch(page.text, new RegExp(`versions/${foreignDraft.id}"`));
  const after = await crit.getVersion(db, otherFirm, foreignDraft.id);
  assert.equal(after.status, 'draft');
  assert.deepEqual(after.questions, foreignDraft.questions);
  assert.equal((await crit.getActiveModel(db, otherFirm)).version, 1);
});

test('deleting a firm removes its criticality versions', async () => {
  const doomed = await newFirm('Departing Criticality Firm');
  const doomedManager = await firmUser('criticality-departing@test.local', 'manager', doomed);
  const { model } = await crit.createDraft(db, doomedManager);
  await crit.activateDraft(db, doomedManager, model.id);
  assert.equal((await versions(doomed)).length, 2);
  await require('../lib/workspace-deletion').deleteFirm(db, doomed);
  assert.equal((await versions(doomed)).length, 0);
});

test('the criticality forms are CSRF-protected', async () => {
  await discardAnyDraft();
  const before = (await versions()).length;
  const create = await client.post('/tprm/settings/criticality/drafts', {}, { csrf: false });
  assert.equal(create.status, 403);
  assert.match(create.text, /CSRF token missing or invalid/);
  assert.equal((await versions()).length, before);

  const { model: draft } = await crit.createDraft(db, manager);
  const changed = clone(draft);
  changed.questions[0].answers[0].tier = 'Critical';
  const save = await client.post(`/tprm/settings/criticality/versions/${draft.id}`, formBody(changed, { op: 'save', _csrf: 'f'.repeat(64) }), { csrf: false });
  assert.equal(save.status, 403);
  assert.equal((await crit.getVersion(db, firmId, draft.id)).questions[0].answers[0].tier, 'Low');
  const activate = await client.post(`/tprm/settings/criticality/versions/${draft.id}/activate`, { row_version: String(draft.rowVersion) }, { csrf: false });
  assert.equal(activate.status, 403);
  const discard = await client.post(`/tprm/settings/criticality/versions/${draft.id}/discard`, { row_version: String(draft.rowVersion) }, { csrf: false });
  assert.equal(discard.status, 403);
  assert.equal((await crit.getVersion(db, firmId, draft.id)).status, 'draft');

  const page = await client.get(`/tprm/settings/criticality/versions/${draft.id}`);
  assert.match(page.text, /data-tprm-draft-form>\s*<input type="hidden" name="_csrf" value="[a-f0-9]+"/, 'the draft form carries the token');
  assert.match(page.text, /data-tprm-discard-draft[^>]*>\s*<input type="hidden" name="_csrf" value="[a-f0-9]+"/, 'the discard form carries the token');
  const review = await client.get(`/tprm/settings/criticality/versions/${draft.id}/activate`);
  assert.match(review.text, /data-tprm-activate-form[\s\S]*name="_csrf" value="[a-f0-9]+"/);
});
