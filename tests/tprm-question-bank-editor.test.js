'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'tprm-bank-editor-tests-password-1234';
const QB = '/tprm/settings/question-bank';

let env;
let db;
let firmId;
let manager;
let consultant;
let editor;
let sheet;
let assembly;
const sessions = [];

test.before(async () => {
  env = await bootClient();
  db = require('../db').db;
  editor = require('../lib/tprm/bank-editor');
  sheet = require('../lib/tprm/bank-sheet');
  assembly = require('../lib/tprm/questionnaire-assembly');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  manager = await makeUser('qb-manager@test.local', 'manager', 'Morgan Manager');
  consultant = await makeUser('qb-consultant@test.local', 'consultant', 'Casey Consultant');
});

test.after(async () => {
  for (const s of sessions) await s.close();
  if (env && env.client) await env.client.close();
});

async function makeUser(email, role, name) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), name, firmId, role)).lastInsertRowid);
  return { id, email, firm_role: role, user_type: 'firm', firm_id: firmId, name };
}

async function sessionFor(user) {
  if (user.session) return user.session;
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email: user.email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${user.email} signs in`);
  await session.get('/dashboard');
  sessions.push(session);
  user.session = session;
  return session;
}

const toast = res => decodeURIComponent(String(res.location || '')).replace(/\+/g, ' ');
const draftNow = async () => editor.draftRow(db);
const latestNow = async () => editor.latest(db);
const pickRetirable = content => {
  const keep = editor.protectedIds(content);
  return content.questions.find(q => q.set === 'Base' && !keep.has(q.id) && q.answered_by !== 'Consultant' && /^IAM-/.test(q.id))
    || content.questions.find(q => q.set === 'Base' && !keep.has(q.id));
};

async function uploadSheet(session, buffer, filename = 'question-bank.xlsx') {
  const form = new FormData();
  form.append('_csrf', session.getCsrfToken());
  form.append('sheet', new Blob([buffer]), filename);
  const res = await fetch(`${await session.baseUrl()}${QB}/import`, { method: 'POST', body: form, redirect: 'manual', headers: { cookie: session.getCookies() } });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

test('the page lists the published bank; only a manager can start a draft', async () => {
  const c = await sessionFor(consultant);
  const page = await c.get(QB);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-question-bank/);
  assert.match(page.text, /data-tprm-bank-row="GOV-01"/);
  assert.doesNotMatch(page.text, /data-tprm-bank-start/);
  const refused = await c.post(`${QB}/draft`, {});
  assert.equal(refused.status, 403);
  assert.equal(await draftNow(), null);

  const m = await sessionFor(manager);
  const mine = await m.get(QB);
  assert.match(mine.text, /data-tprm-bank-start/);
  const home = await m.get('/tprm');
  assert.match(home.text, /href="\/tprm\/settings" data-tprm-settings-button>Settings</);
  assert.match((await m.get('/tprm/settings')).text, /data-tprm-question-bank-link/);
  for (const tab of ['/tprm/review', '/tprm/questionnaires', '/tprm/due', '/tprm/conditions']) {
    assert.match((await m.get(tab)).text, /href="\/tprm\/settings" data-tprm-settings-button>Settings</, `${tab} has the Settings button`);
  }
  assert.doesNotMatch(home.text, /data-tprm-question-bank-link/, 'the settings no longer sit at the bottom of the home page');
  const filtered = await m.get(`${QB}?q=GOV-01`);
  assert.match(filtered.text, /data-tprm-bank-row="GOV-01"/);
  assert.doesNotMatch(filtered.text, /data-tprm-bank-row="IAM-01"/);
});

test('a manager rewords a question in a draft, reviews the change and publishes a new version', async () => {
  const m = await sessionFor(manager);
  const before = await latestNow();
  const started = await m.post(`${QB}/draft`, {});
  assert.equal(started.status, 302);
  const draft = await draftNow();
  assert.ok(draft);
  assert.equal(Number(draft.base_version_id), Number(before.id));

  const q = draft.content.questions.find(x => x.id === 'GOV-01');
  const edit = await m.get(`${QB}/questions/GOV-01`);
  assert.match(edit.text, /data-tprm-bank-form/);
  assert.match(edit.text, /data-tprm-bank-protected|data-tprm-bank-retire/);
  const save = await m.post(`${QB}/questions/GOV-01`, {
    row_version: draft.row_version, theme: q.theme, question: 'How often is your information security policy reviewed and approved?',
    guidance: q.guidance, evidence: q.evidence, evidence_mandatory: '1', min_tier: q.min_tier, benchmark: q.benchmark || '', iso27001: q.iso27001 || '',
  });
  assert.equal(save.status, 302, save.text.slice(0, 300));
  assert.match(toast(save), /saved in the draft/);

  const stale = await m.post(`${QB}/questions/GOV-01`, {
    row_version: draft.row_version, theme: q.theme, question: 'Overwritten from an old tab', min_tier: q.min_tier,
  });
  assert.match(toast(stale), /Someone else changed the draft/);
  assert.equal((await draftNow()).content.questions.find(x => x.id === 'GOV-01').question, 'How often is your information security policy reviewed and approved?');

  const list = await m.get(QB);
  assert.match(list.text, /data-tprm-bank-row="GOV-01"[\s\S]*?Changed/);
  const review = await m.get(`${QB}/publish`);
  assert.equal(review.status, 200);
  assert.match(review.text, /data-tprm-bank-changed[\s\S]*GOV-01[\s\S]*Question/);
  assert.match(review.text, /data-tprm-bank-publish-form/);

  const cPublish = await (await sessionFor(consultant)).post(`${QB}/publish`, {});
  assert.equal(cPublish.status, 403);

  const now = await draftNow();
  const pub = await m.post(`${QB}/publish`, { row_version: now.row_version, note: 'Policy question reworded' });
  assert.equal(pub.status, 302);
  assert.match(toast(pub), new RegExp(`Version ${before.version + 1} published`));
  const after = await latestNow();
  assert.equal(after.version, before.version + 1);
  assert.equal(Number(after.published_by), manager.id);
  assert.match(after.content.version, new RegExp(`version ${after.version}$`));
  assert.equal(after.content.questions.find(x => x.id === 'GOV-01').question, 'How often is your information security policy reviewed and approved?');
  assert.equal(after.content.questions.length, before.content.questions.length);
  assert.deepEqual(Object.keys(after.content).sort(), [...new Set([...Object.keys(before.content), 'retired_ids'])].sort());
  for (const k of ['rulebooks', 'module_triggers', 'contract_checklist', 'glossary']) assert.deepEqual(after.content[k], before.content[k], `${k} is carried through`);
  const row = await db.prepare('SELECT source FROM tp_question_bank_versions WHERE id = ?').get(after.id);
  assert.match(row.source, /1 changed[\s\S]*Policy question reworded/);
  assert.equal(await draftNow(), null);
  const audit = await db.prepare(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'tprm_question_bank_published'`).get();
  assert.equal(audit.n, 1);
  const again = await m.post(`${QB}/publish`, {});
  assert.match(toast(again), /no draft/i);
});

test('retired numbers are never reused, protected questions stay, and a question can be added beside another', async () => {
  const m = await sessionFor(manager);
  await m.post(`${QB}/draft`, {});
  let draft = await draftNow();
  const victim = pickRetirable(draft.content);
  assert.ok(victim, 'a question that can be retired');

  const keep = await m.post(`${QB}/questions/GOV-07/retire`, { row_version: draft.row_version });
  assert.match(toast(keep), /used by the tool itself/);
  const page = await m.get(`${QB}/questions/GOV-07`);
  assert.match(page.text, /data-tprm-bank-protected/);
  const rb = draft.content.questions.find(q => q.set === editor.RULEBOOK_SET);
  const rbRes = await m.post(`${QB}/questions/${rb.id}/retire`, { row_version: draft.row_version });
  assert.match(toast(rbRes), /belongs to a rulebook/);

  const prefix = victim.id.split('-')[0];
  const sameSet = draft.content.questions.filter(q => q.id.startsWith(`${prefix}-`)).map(q => Number(q.id.split('-')[1]));
  const highest = Math.max(...sameSet);
  const last = draft.content.questions.find(q => q.id === `${prefix}-${String(highest).padStart(2, '0')}`) || victim;
  if (!editor.protectedIds(draft.content).has(last.id) && last.set !== editor.RULEBOOK_SET) {
    const r = await m.post(`${QB}/questions/${last.id}/retire`, { row_version: draft.row_version });
    assert.match(toast(r), /retired in the draft/);
    draft = await draftNow();
    assert.ok(draft.content.retired_ids.includes(last.id));
    assert.ok(!draft.content.questions.some(q => q.id === last.id));
  }

  const addForm = await m.get(`${QB}/add?like=${victim.id}`);
  assert.equal(addForm.status, 200);
  const shownId = (addForm.text.match(/It will be <b>([A-Z]+-\d+)<\/b>/) || [])[1];
  assert.ok(shownId);
  const bad = await m.post(`${QB}/add`, { row_version: draft.row_version, like: victim.id, theme: '', question: '', min_tier: 'Low' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Theme is required/);
  const add = await m.post(`${QB}/add`, {
    row_version: draft.row_version, like: victim.id, theme: 'Access reviews for contractors',
    question: 'Do you review contractor access every quarter?', guidance: '', evidence: 'Last review record', evidence_mandatory: '1', min_tier: 'Low',
  });
  assert.equal(add.status, 302, add.text.slice(0, 300));
  draft = await draftNow();
  const added = draft.content.questions.find(q => q.theme === 'Access reviews for contractors');
  assert.equal(added.id, shownId);
  assert.ok(Number(added.id.split('-')[1]) > highest, 'the new number is above every used or retired one');
  assert.equal(added.answer_type, victim.answer_type === 'free_text' ? 'free_text' : 'yes_no_na');
  assert.equal(added.fields, undefined);
  assert.equal(added.report_coverage, 'none');
  assert.equal(draft.content.questions.indexOf(added), draft.content.questions.findIndex(q => q.id === victim.id) + 1);
  const rbAdd = await m.post(`${QB}/add`, { row_version: draft.row_version, like: rb.id, theme: 'x', question: 'y', min_tier: 'Low' });
  assert.equal(rbAdd.status, 400);
  assert.match(rbAdd.text, /rulebook/);

  const set = assembly.assemble(draft.content, { tier: 'critical', deliveryModel: 'vendor_hosted' });
  const has = id => set.sections.some(x => x.ids.includes(id)) || set.consultantChecks.some(c => c.id === id);
  assert.equal(has(added.id), has(victim.id), 'the new question is asked wherever the one it sits beside is asked');

  const r2 = await m.post(`${QB}/questions/${victim.id}/retire`, { row_version: draft.row_version });
  assert.match(toast(r2), /retired in the draft/);
  const listed = await m.get(QB);
  assert.match(listed.text, new RegExp(`data-tprm-bank-retired[\\s\\S]*${victim.id}`));
  draft = await draftNow();
  const back = await m.post(`${QB}/questions/${victim.id}/restore`, { row_version: draft.row_version });
  assert.match(toast(back), /brought back/);
  draft = await draftNow();
  assert.ok(draft.content.questions.some(q => q.id === victim.id));
  assert.ok(!draft.content.retired_ids.includes(victim.id));

  const d = editor.diff((await latestNow()).content, draft.content);
  assert.deepEqual(d.added, [added.id]);
  const discarded = await m.post(`${QB}/draft/discard`, {});
  assert.match(toast(discarded), /Draft discarded/);
  assert.equal(await draftNow(), null);
});

test('publishing checks the draft: a stale base, a changed answer type and a removed protected question are refused', async () => {
  const m = await sessionFor(manager);
  const top = await latestNow();
  const base = top.content;
  const broken = JSON.parse(JSON.stringify(base));
  const yn = broken.questions.find(q => q.answer_type === 'yes_no_na');
  yn.answer_type = 'free_text';
  broken.questions = broken.questions.filter(q => q.id !== 'ASR-01');
  broken.questions.push({ ...broken.questions[0], id: 'GOV-99', question: 'Uses a retired number' });
  broken.retired_ids = ['GOV-99'];
  const errors = editor.validate(base, broken);
  assert.ok(errors.some(e => e.includes(`${yn.id}: the answer type cannot change`)));
  assert.ok(errors.some(e => e.includes('ASR-01')));
  assert.ok(errors.some(e => e.includes('retired and cannot be used again')));
  assert.deepEqual(editor.validate(base, base), []);

  await m.post(`${QB}/draft`, {});
  const draft = await draftNow();
  const q = draft.content.questions.find(x => x.id === 'GOV-02');
  await editor.updateQuestion(db, manager, 'GOV-02', { theme: q.theme, question: `${q.question} (reworded)`, min_tier: q.min_tier, evidence_mandatory: q.evidence_mandatory ? '1' : '' });
  const other = { ...base, version: 'Another release', questions: base.questions.map(x => (x.id === 'GOV-03' ? { ...x, guidance: 'Elsewhere' } : x)) };
  const raw = JSON.stringify(other);
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, source, content, content_sha256, question_count)
    VALUES (?, ?, ?, ?::jsonb, ?, ?)`).run(top.version + 1, 'Another release', 'Published elsewhere', raw, crypto.createHash('sha256').update(raw).digest('hex'), other.questions.length);
  const review = await m.get(`${QB}/publish`);
  assert.match(review.text, /data-tprm-bank-stale/);
  assert.doesNotMatch(review.text, /data-tprm-bank-publish-form/);
  const pub = await m.post(`${QB}/publish`, {});
  assert.match(toast(pub), /newer version was published/);
  assert.equal((await latestNow()).version, top.version + 1);
  await m.post(`${QB}/draft/discard`, {});
});

test('the Excel file round-trips: unchanged it changes nothing; edited it fills the draft; a protected retire is refused', async () => {
  const m = await sessionFor(manager);
  const top = await latestNow();
  const file = await fetch(`${await m.baseUrl()}${QB}/export.xlsx`, { headers: { cookie: m.getCookies() } });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /spreadsheetml/);
  assert.match(file.headers.get('content-disposition'), new RegExp(`question-bank-version-${top.version}\\.xlsx`));
  const buffer = Buffer.from(await file.arrayBuffer());
  const rows = await sheet.parseUpload(buffer);
  assert.equal(rows.length, top.content.questions.length);

  const same = await uploadSheet(m, buffer);
  assert.equal(same.status, 302, same.text.slice(0, 300));
  assert.match(decodeURIComponent(same.location || ''), /nothing in it differs/);
  assert.equal(await draftNow(), null, 'an upload that changes nothing leaves no draft behind');

  const victim = pickRetirable(top.content);
  const edited = JSON.parse(JSON.stringify(top.content));
  edited.questions.find(q => q.id === 'GOV-01').benchmark = 'Reviewed every year and after any major change.';
  const changedBuf = await sheet.buildWorkbook(edited, 'Edited');
  const parsed = await sheet.parseUpload(changedBuf);
  parsed.find(r => r.id === victim.id).retire = true;
  const r = await editor.importRows(db, manager, parsed);
  assert.deepEqual({ changed: r.changed, retired: r.retired }, { changed: 1, retired: 1 });
  const d = editor.diff(top.content, (await draftNow()).content);
  assert.deepEqual(d.changed, [{ id: 'GOV-01', fields: ['benchmark'] }]);
  assert.deepEqual(d.retired, [victim.id]);

  const protectedRows = (await sheet.parseUpload(buffer)).map(x => (x.id === 'GOV-07' ? { ...x, retire: true } : x));
  await assert.rejects(() => editor.importRows(db, manager, protectedRows), /GOV-07: used by the tool itself/);
  const unknown = [{ id: 'ZZZ-01', retire: false, values: {} }];
  await assert.rejects(() => editor.importRows(db, manager, unknown), /ZZZ-01: not in the question bank/);

  const notXlsx = await uploadSheet(m, Buffer.from('a,b\n1,2\n'), 'bank.csv');
  assert.equal(notXlsx.status, 400);
  const dl = await fetch(`${await m.baseUrl()}${QB}/export.xlsx`, { headers: { cookie: m.getCookies() } });
  assert.match(dl.headers.get('content-disposition'), /question-bank-draft\.xlsx/);
  const consultantUpload = await uploadSheet(await sessionFor(consultant), buffer);
  assert.equal(consultantUpload.status, 403);
  await m.post(`${QB}/draft/discard`, {});
});

test('a number used by any earlier version is never handed out again, and a module cannot be emptied', async () => {
  const m = await sessionFor(manager);
  const top = await latestNow();
  const nums = prefix => top.content.questions.filter(q => q.id.startsWith(`${prefix}-`)).map(q => Number(q.id.split('-')[1]));
  const prefix = 'GOV';
  const highest = Math.max(...nums(prefix));
  const gone = `${prefix}-${String(highest).padStart(2, '0')}`;
  const without = { ...top.content, version: 'Without the last governance question', questions: top.content.questions.filter(q => q.id !== gone) };
  const raw = JSON.stringify(without);
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, source, content, content_sha256, question_count)
    VALUES (?, ?, ?, ?::jsonb, ?, ?)`).run(top.version + 1, 'Without one', 'Test', raw, crypto.createHash('sha256').update(raw).digest('hex'), without.questions.length);
  await m.post(`${QB}/draft`, {});
  const draft = await draftNow();
  assert.ok(draft.content.retired_ids.includes(gone), `${gone} is remembered as used`);
  assert.equal(editor.nextId(draft.content, prefix), `${prefix}-${String(highest + 1).padStart(2, '0')}`);
  const reuse = JSON.parse(JSON.stringify(draft.content));
  reuse.retired_ids = [];
  reuse.questions.push({ ...top.content.questions.find(q => q.id === gone) });
  const errs = editor.validate((await latestNow()).content, reuse, await editor.everUsedIds(db));
  assert.ok(errs.some(e => e.includes(`${gone}: this number was retired`)));

  const base = (await latestNow()).content;
  const mod = assembly.offeredModules(base)[0];
  const empty = { ...base, questions: base.questions.filter(q => !(q.set === 'Module' && q.pack === mod)) };
  assert.ok(editor.validate(base, empty).some(e => e.includes(`The ${mod} module would have no questions left`)));

  const noLike = await m.get(`${QB}/add`);
  assert.equal(noLike.status, 404);
  await m.post(`${QB}/draft/discard`, {});
  const noDraft = await m.get(`${QB}/add?like=GOV-01`);
  assert.equal(noDraft.status, 302);
  assert.match(toast(noDraft), /Start a draft first/);
});

test('new questionnaires use the newest published version', async () => {
  const q = require('../lib/tprm/questionnaires');
  const latest = await q.latestBankVersion(db);
  const top = await latestNow();
  assert.equal(Number(latest.id), Number(top.id));
});

test('the bank: a new section, a choice question that is optional and asked by a rule, AI instructions, and renaming and moving a section', async () => {
  const m = await sessionFor(manager);
  if (!(await draftNow())) assert.equal((await m.post(`${QB}/draft`, {})).status, 302);
  let draft = await draftNow();
  const page = await m.get(QB);
  assert.match(page.text, /data-tprm-bank-sections[\s\S]*?data-tprm-bank-add-form[\s\S]*?data-tprm-bank-new-section/);
  const lastBase = [...draft.content.questions].reverse().find(x => x.set === 'Base');
  const fresh = await m.get(`${QB}/add?new=1`);
  assert.match(fresh.text, /name="new_section"/);
  assert.match(fresh.text, /value="multiple_choice"/);
  const sec = await m.post(`${QB}/add`, { row_version: String(draft.row_version), like: lastBase.id, new_section_shown: '1', new_section: 'Business continuity', new_prefix: 'BCX',
    answer_type: 'yes_no_na', theme: 'Continuity plan', question: 'Do you have a documented business continuity plan?', min_tier: 'Low' });
  assert.equal(sec.status, 302, (sec.text || '').match(/data-tprm-bank-errors[\s\S]{0,300}/) || toast(sec));
  draft = await draftNow();
  const parent = draft.content.questions.find(x => x.theme === 'Continuity plan');
  assert.deepEqual([parent.id, parent.domain, parent.set, parent.answer_type], ['BCX-01', 'Business continuity', 'Base', 'yes_no_na']);

  const one = await m.post(`${QB}/add`, { row_version: String(draft.row_version), like: 'BCX-01', answer_type: 'single_choice', options: ['Only'], theme: 'x', question: 'y', min_tier: 'Low' });
  assert.equal(one.status, 400);
  assert.match(one.text, /needs at least two options/);
  const other = draft.content.questions.find(x => x.set === 'Base' && x.domain !== 'Business continuity');
  const wrong = await m.post(`${QB}/add`, { row_version: String(draft.row_version), like: 'BCX-01', answer_type: 'yes_no_na', theme: 'x', question: 'y', min_tier: 'Low',
    show_mode: 'when', show_join: 'all', cond_question: [other.id], cond_op: ['is'], cond_value: ['yes'] });
  assert.equal(wrong.status, 400);
  assert.match(wrong.text, /can only use questions in the same section/);

  const maybe = await m.post(`${QB}/add`, { row_version: String(draft.row_version), like: 'BCX-01', answer_type: 'yes_no_na', theme: 'x', question: 'y', min_tier: 'Low',
    show_mode: 'when', show_join: 'all', cond_question: ['BCX-01'], cond_op: ['is'], cond_value: ['maybe'] });
  assert.equal(maybe.status, 400);
  assert.match(maybe.text, /for BCX-01 use &#34;is&#34; or &#34;is not&#34; with yes, no or na/);
  await db.prepare(`INSERT INTO tp_q_templates (firm_id, name, prefix) VALUES (?, 'Firm owned', 'ZZQ')`).run(firmId);
  const taken = await m.post(`${QB}/add`, { row_version: String(draft.row_version), like: lastBase.id, new_section_shown: '1', new_section: 'Something else', new_prefix: 'ZZQ',
    answer_type: 'yes_no_na', theme: 'x', question: 'y', min_tier: 'Low' });
  assert.equal(taken.status, 400);
  assert.match(taken.text, /ZZQ is already used by a firm questionnaire/);
  const add = await m.post(`${QB}/add`, { row_version: String(draft.row_version), like: 'BCX-01', answer_type: 'single_choice', options: ['Yearly', 'Every two years', 'Never'],
    theme: 'Plan testing', question: 'How often is the plan tested?', min_tier: 'Low', required_shown: '1',
    show_mode: 'when', show_join: 'all', cond_question: ['BCX-01', ''], cond_op: ['is', 'is'], cond_value: ['yes', ''],
  });
  assert.equal(add.status, 302, (add.text || '').match(/data-tprm-bank-errors[\s\S]{0,300}/) || toast(add));
  draft = await draftNow();
  const child = draft.content.questions.find(x => x.theme === 'Plan testing');
  assert.equal(child.id, 'BCX-02');
  assert.deepEqual(child.options, ['Yearly', 'Every two years', 'Never']);
  assert.equal(child.required, false);
  assert.deepEqual(child.show_when, { mode: 'all', conditions: [{ question: 'BCX-01', op: 'is', value: 'yes' }] });
  const childPage = await m.get(`${QB}/questions/BCX-02`);
  assert.match(childPage.text, /data-tprm-question-guide="BCX-02"[\s\S]*?name="valid_answer"[\s\S]*?name="red_flags"/);
  assert.doesNotMatch(childPage.text, /name="ai_valid"/, 'one place for the marking rules');
  const rules = await m.post(`/tprm/settings/marking-guides/BCX-02`, { back: 'question', valid_answer: 'One of the options.', satisfactory: 'Yearly or more often.', partly: 'Every two years.', red_flags: 'Never tested.' });
  assert.equal(rules.status, 302);
  assert.match(String(rules.location), /\/question-bank\/questions\/BCX-02.*#reviewers$/);
  const g = await db.prepare('SELECT valid_answer, satisfactory, partly, red_flags FROM tp_marking_guides WHERE question_id = ?').get('BCX-02');
  assert.deepEqual([g.valid_answer, g.satisfactory, g.partly, g.red_flags], ['One of the options.', 'Yearly or more often.', 'Every two years.', 'Never tested.']);
  const shown = await m.get(`${QB}/questions/BCX-02`);
  assert.match(shown.text, /Single choice \(Yearly, Every two years, Never\)/);
  assert.match(shown.text, /<option value="BCX-01" selected>/);

  const yn = draft.content.questions.find(x => x.set === 'Base' && x.answer_type === 'yes_no_na' && !editor.protectedIds(draft.content).has(x.id) && !x.fields);
  const govSettings = await m.post(`${QB}/questions/${yn.id}`, { row_version: String(draft.row_version), theme: yn.theme, question: yn.question, min_tier: yn.min_tier,
    settings_shown: '1', ask_file: '1', file_when: 'any', evidence: 'The approved policy', evidence_mandatory: '1', explain_on: ['yes'] });
  assert.equal(govSettings.status, 302, (govSettings.text || '').match(/data-tprm-bank-errors[\s\S]{0,300}/) || toast(govSettings));
  draft = await draftNow();
  const gov = draft.content.questions.find(x => x.id === yn.id);
  assert.deepEqual([gov.evidence_on, gov.evidence_mandatory, gov.explain_on], ['any', true, ['yes']]);
  assert.deepEqual(require('../lib/tprm/answer-rules').questionRules(gov).evidenceOn, ['yes', 'no']);
  const opts = await m.post(`${QB}/questions/BCX-02`, { row_version: String(draft.row_version), theme: 'Plan testing', question: 'How often is the plan tested?', min_tier: 'Low',
    settings_shown: '1', options: ['Yearly', 'Twice a year', 'Never'] });
  assert.equal(opts.status, 302, (opts.text || '').match(/data-tprm-bank-errors[\s\S]{0,300}/) || toast(opts));
  draft = await draftNow();
  assert.deepEqual(draft.content.questions.find(x => x.id === 'BCX-02').options, ['Yearly', 'Twice a year', 'Never']);
  const renamed = await m.post(`${QB}/sections/rename`, { row_version: String(draft.row_version), section: 'Business continuity', title: 'Continuity' });
  assert.match(toast(renamed), /Section renamed to Continuity/);
  draft = await draftNow();
  assert.deepEqual(draft.content.questions.filter(x => x.domain === 'Continuity').map(x => x.id), ['BCX-01', 'BCX-02']);
  const before = editor.baseSections(draft.content);
  const at = before.indexOf('Continuity');
  assert.match(toast(await m.post(`${QB}/sections/move`, { row_version: String(draft.row_version), section: 'Continuity', dir: 'up' })), /Continuity moved/);
  draft = await draftNow();
  assert.equal(editor.baseSections(draft.content).indexOf('Continuity'), at - 1);

  const pub = await m.post(`${QB}/publish`, { row_version: String(draft.row_version) });
  assert.equal(pub.status, 302, toast(pub));
  const overview = await m.get('/tprm/settings/marking-guides?q=BCX-02');
  assert.match(overview.text, /data-tprm-guide-row="BCX-02"[\s\S]*?A valid answer:<\/b> One of the options\.[\s\S]*?data-tprm-guide-edit="BCX-02"/);
  assert.doesNotMatch(overview.text, /data-tprm-guide-form/, 'the overview has no forms');
  const latest = await latestNow();
  const content = typeof latest.content === 'string' ? JSON.parse(latest.content) : latest.content;
  const built = assembly.DELIVERY_MODELS.map(dm => assembly.assemble(content, { tier: 'critical', deliveryModel: dm, modules: [] }))
    .flatMap(r => r.sections).find(s => s.title === 'Continuity');
  assert.ok(built, 'the new section is asked');
  assert.deepEqual(built.ids, ['BCX-01']);
  assert.deepEqual(built.followups, [{ id: 'BCX-02', parent: 'BCX-01', rule: { mode: 'all', conditions: [{ question: 'BCX-01', op: 'is', value: 'yes' }] } }]);
});

test('the bank Excel file carries answer settings and marking rules; rules alone are saved without starting a draft', async () => {
  const m = await sessionFor(manager);
  await m.post(`${QB}/draft/discard`, {});
  const guides = require('../lib/tprm/marking-guides');
  const qsheet = require('../lib/tprm/question-sheet');
  const top = await latestNow();
  const keep = editor.protectedIds(top.content);
  const yn = top.content.questions.find(x => x.set === 'Base' && x.answer_type === 'yes_no_na' && !keep.has(x.id) && !x.fields && !x.show_when && !x.ask_when && x.required !== false);
  const labels = sheet.COLUMNS.map(c => c.label);
  for (const c of [...qsheet.SETTINGS_COLUMNS.filter(x => !['evidence', 'evidence_mandatory'].includes(x.key)), ...qsheet.RULE_COLUMNS]) assert.ok(labels.includes(c.label), c.label);

  const rulesOnly = await sheet.buildWorkbook(top.content, 'Rules', new Map([...(await guides.forFirm(db, firmId)), [yn.id, { satisfactory: 'A policy approved in the last year.' }]]));
  const r1 = await uploadSheet(m, rulesOnly);
  assert.equal(r1.status, 302, r1.text.slice(0, 300));
  assert.match(toast(r1), /marking rules saved for 1 question\./);
  assert.equal(await draftNow(), null, 'rules alone do not start a draft');
  assert.equal((await guides.forFirm(db, firmId, [yn.id])).get(yn.id).satisfactory, 'A policy approved in the last year.');

  const edited = JSON.parse(JSON.stringify(top.content));
  const e = edited.questions.find(x => x.id === yn.id);
  e.required = false;
  e.explain_on = JSON.stringify(e.explain_on) === '["yes"]' ? ['no'] : ['yes'];
  const both = await sheet.buildWorkbook(edited, 'Edited', new Map([...(await guides.forFirm(db, firmId)), [yn.id, { satisfactory: 'A policy approved in the last year.', red_flags: 'No owner.' }]]));
  const r2 = await uploadSheet(m, both);
  assert.equal(r2.status, 302, r2.text.slice(0, 300));
  assert.match(toast(r2), /1 question changed and 0 retired in the draft, and marking rules saved for 1 question/);
  const d = (await draftNow()).content.questions.find(x => x.id === yn.id);
  assert.equal(d.required, false);
  assert.deepEqual(d.explain_on, e.explain_on);
  assert.deepEqual(editor.diff(top.content, (await draftNow()).content).changed, [{ id: yn.id, fields: ['required', 'explain_on'] }], JSON.stringify(editor.diff(top.content, (await draftNow()).content).changed));
  assert.equal((await guides.forFirm(db, firmId, [yn.id])).get(yn.id).red_flags, 'No owner.');
  const review = await m.get(`${QB}/publish`);
  assert.match(review.text, new RegExp(`${yn.id}[\\s\\S]*?Answer required</td><td class="fx-sm fx-muted">Yes</td><td class="fx-sm">No</td>`));
  assert.doesNotMatch(review.text, /\[object Object\]/);

  const rows = await sheet.parseUpload(await sheet.buildWorkbook(top.content, 'x', await guides.forFirm(db, firmId)));
  const row = rows.find(x => x.id === yn.id);
  row.cells.answer_type = 'Written answer';
  await assert.rejects(() => editor.importRows(db, manager, [row]), new RegExp(`${yn.id}: how it is answered cannot change in the file`));
  const ruleRow = rows.find(x => x.id === yn.id);
  ruleRow.cells.answer_type = null;
  ruleRow.cells.show_when = 'GOV-01 is maybe';
  await assert.rejects(() => editor.importRows(db, manager, [ruleRow]), /use "is" or "is not" with yes, no or na|its rule|has no fixed answers/);
  await m.post(`${QB}/draft/discard`, {});
  await guides.save(db, manager, yn.id, {});
});
