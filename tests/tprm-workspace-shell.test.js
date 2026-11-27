'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

let env;
let client;
let db;
let firmId;
let managerId;
const sessions = [];
const PASSWORD = 'workspace-shell-password-1234';

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
});

test.after(async () => {
  for (const s of sessions) await s.close();
  if (client) await client.close();
});

async function workspace(name, { iso = false, tprm = false, firm = firmId, scope = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome,scope,lead_consultant_id)
    VALUES (?,?,?,'certification_support',?,?)`).run(firm, name, JSON.stringify(iso ? ['iso27001'] : []), scope, firm === firmId ? managerId : null)).lastInsertRowid);
  if (tprm) await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  return id;
}

async function thirdParty(ws, name, extra = {}) {
  return Number((await db.prepare(`INSERT INTO tp_third_parties (workspace_id, name, status, category, next_due_date)
    VALUES (?, ?, ?, ?, ?)`).run(ws, name, extra.status || 'in_use', extra.category || null, extra.next_due_date || null)).lastInsertRowid);
}

async function firmSession(email, role, { firm = firmId, memberOf = [] } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, firm, role)).lastInsertRowid);
  for (const ws of memberOf) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(ws, id, role);
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${email} signs in`);
  await session.get('/dashboard');
  sessions.push(session);
  return { id, session };
}

async function search(session, q, wsId = null) {
  const res = await session.get(`/api/search?${new URLSearchParams(wsId ? { q, wsId } : { q })}`);
  assert.equal(res.status, 200);
  return JSON.parse(res.text);
}

test('global search finds third parties of clients the user can open, and opens a TPRM-only client on its third-party risk page', async () => {
  const harbour = await workspace('Harbourline Searchco', { tprm: true });
  const iso = await workspace('Atlas Searchco ISO', { iso: true });
  const nimbus = await thirdParty(harbour, 'PayNimbus Searchable', { category: 'Payments' });
  const foreignFirm = Number((await db.prepare("INSERT INTO firms(name) VALUES ('Search Foreign Firm')").run()).lastInsertRowid);
  const foreign = await workspace('Foreign Searchco', { tprm: true, firm: foreignFirm });
  await thirdParty(foreign, 'PayNimbus Foreign Twin');

  const found = await search(client, 'paynimbus');
  const tp = found.filter(r => r.type === 'Third party');
  assert.deepEqual(tp.map(r => r.label), ['PayNimbus Searchable'], 'another firm\'s supplier never appears');
  assert.equal(tp[0].href, `/tprm/clients/${harbour}/third-parties/${nimbus}`);
  assert.match(tp[0].sublabel, /Harbourline Searchco/);

  const clients = (await search(client, 'searchco')).filter(r => r.type === 'Client');
  const byName = Object.fromEntries(clients.map(r => [r.label, r.href]));
  assert.equal(byName['Harbourline Searchco'], `/tprm/clients/${harbour}`);
  assert.equal(byName['Atlas Searchco ISO'], `/workspaces/${iso}`);
  assert.ok(!('Foreign Searchco' in byName));

  const page = await client.get(`/tprm/clients/${harbour}/third-parties/${nimbus}`);
  assert.equal(page.status, 200, 'the search result opens the supplier page');
});

test('global search does not return suppliers of a client the consultant is not on', async () => {
  const mine = await workspace('Consultant Own Searchclient', { tprm: true });
  const notMine = await workspace('Consultant Other Searchclient', { tprm: true });
  await thirdParty(mine, 'Quartzline Visible Supplier');
  await thirdParty(notMine, 'Quartzline Hidden Supplier');
  const { session } = await firmSession('shell-search-consultant@test.local', 'consultant', { memberOf: [mine] });
  const labels = (await search(session, 'quartzline')).filter(r => r.type === 'Third party').map(r => r.label);
  assert.deepEqual(labels, ['Quartzline Visible Supplier']);
});

test('the client activity log includes the consultants\' third-party risk actions for that client', async () => {
  const events = require('../lib/tprm/events');
  const ws = await workspace('Activity Lumen Client', { tprm: true });
  const tp = await thirdParty(ws, 'Lumen Activity Supplier');
  const other = await workspace('Activity Other Client', { tprm: true });
  const otherTp = await thirdParty(other, 'Elsewhere Activity Supplier');
  await events.appendEvent(db, { workspaceId: ws, thirdPartyId: tp, actorId: managerId, action: 'condition.changes_requested', after: { position: 2, reason: 'Send the signed copy' } });
  await events.appendEvent(db, { workspaceId: other, thirdPartyId: otherTp, actorId: managerId, action: 'third_party.team_changed', after: {} });

  const page = await client.get(`/workspaces/${ws}/activity-log`);
  assert.equal(page.status, 200);
  const section = page.text.slice(page.text.indexOf('data-activity-third-party-risk'));
  assert.ok(section.length > 0, 'the log has a third-party risk section');
  assert.match(section, /Lumen Activity Supplier/);
  assert.match(section, /asked for changes to the proof of condition 2: Send the signed copy/);
  assert.doesNotMatch(section, /Elsewhere Activity Supplier/, 'another client\'s actions are not listed');
  assert.match(page.text, /Third-party risk actions for this client follow the main log/);

  const filtered = await client.get(`/workspaces/${ws}/activity-log?${new URLSearchParams({ q: 'nothing-matches-this' })}`);
  assert.doesNotMatch(filtered.text.slice(filtered.text.indexOf('data-activity-third-party-risk')), /Lumen Activity Supplier/);

  const iso = await workspace('Activity ISO Only Client', { iso: true });
  const isoPage = await client.get(`/workspaces/${iso}/activity-log`);
  assert.equal(isoPage.status, 200);
  assert.doesNotMatch(isoPage.text, /data-activity-third-party-risk/, 'an ISO client without third-party risk is unchanged');
  assert.doesNotMatch(isoPage.text, /Third-party risk actions/);
});

test('the client activity log names who acted for the third party, words every event plainly and names the zone', async () => {
  const events = require('../lib/tprm/events');
  const ws = await workspace('Activity Plainwords Client', { tprm: true });
  await db.prepare("UPDATE workspaces SET timezone = 'Asia/Kolkata' WHERE id = ?").run(ws);
  const tp = await thirdParty(ws, 'Plainwords Activity Supplier');
  const manager = await db.prepare('SELECT name FROM users WHERE id = ?').get(managerId);
  const add = (action, after = null, before = null) => events.appendEvent(db, { workspaceId: ws, thirdPartyId: tp, actorId: managerId, action, after, before });
  await add('third_party.created', { name: 'Plainwords Activity Supplier' });
  await add('third_party.updated', { website: 'https://plain.example' }, { website: null });
  await add('third_party.tier_assessed', { current_tier: 'high', tier_source: 'assessed' }, { current_tier: null });
  await add('service.added', { service_id: 1, description: 'Statement printing' });
  await add('service.updated', { service_id: 1, annual_spend: 5000 }, { service_id: 1, annual_spend: 4000 });
  await add('service.removed', null, { service_id: 1, description: 'Statement printing' });
  await add('subprocessor.added', { subprocessor_id: 1, name: 'Northgate Couriers' });
  await add('vendor_person.added', { person_id: 9, name: 'Dana Roy', email: 'dana@plainwords.test', role: 'colleague', by: 'firm' });

  const page = await client.get(`/workspaces/${ws}/activity-log`);
  assert.equal(page.status, 200);
  const section = page.text.slice(page.text.indexOf('data-activity-third-party-risk'));
  const rows = [...section.matchAll(/data-activity-tprm-event="\d+">([\s\S]*?)<\/tr>/g)].map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&#34;/g, '"').replace(/\s+/g, ' ').trim());
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.doesNotMatch(row, /\b(third_party|third party|service|subprocessor|vendor_person)\.[a-z_]+/, row);
    assert.doesNotMatch(row, /Someone at the firm/, row);
    assert.match(row, /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} [ap]m IST /, row);
  }
  const text = rows.join('\n');
  assert.match(text, new RegExp(`${manager.name} \\(for the third party\\) added Dana Roy`));
  assert.match(text, /added the service "Statement printing"/);
  assert.match(text, /removed the service "Statement printing"/);
  assert.match(text, /added the subprocessor "Northgate Couriers"/);
  assert.match(text, /set the tier to High from the confirmed assessment/);
  assert.match(text, /changed the website of the third party/);
  assert.match(text, /added the third party "Plainwords Activity Supplier"/);
});

test('the supplier page shows recent activity and history in plain words, never a raw event code', async () => {
  const events = require('../lib/tprm/events');
  const fs = require('node:fs');
  const path = require('node:path');
  const found = new Set();
  for (const dir of [path.join(__dirname, '..', 'lib', 'tprm'), path.join(__dirname, '..', 'migrations')]) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(js|sql)$/.test(f)) continue;
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/'((?:third_party|service|subprocessor|vendor_person|party_document|client_request|exit_plan)\.[a-z_]+)'/g)) found.add(m[1]);
    }
  }
  const actions = [...found].sort();
  assert.ok(actions.length > 20);
  const ws = await workspace('Rawcode Free Client', { tprm: true });
  for (let i = 0; i < actions.length; i += 15) {
    const tp = await thirdParty(ws, `Rawcode Free Supplier ${i}`);
    for (const action of actions.slice(i, i + 15)) {
      await events.appendEvent(db, { workspaceId: ws, thirdPartyId: tp, actorId: managerId, action, after: { name: 'Dana Roy', email: 'dana@rawcode.test', role: 'colleague', by: 'firm' } });
    }
    const page = await client.get(`/tprm/clients/${ws}/third-parties/${tp}`);
    assert.equal(page.status, 200);
    const feed = page.text.slice(page.text.indexOf('class="fx-feed"'), page.text.indexOf('</section>', page.text.indexOf('class="fx-feed"')));
    const hist = page.text.slice(page.text.indexOf('data-tprm-history'), page.text.indexOf('</section>', page.text.indexOf('data-tprm-history')));
    assert.ok(feed.length > 20 && hist.length > 20);
    for (const part of [feed, hist]) {
      const text = part.replace(/<[^>]+>/g, ' ');
      for (const action of actions) assert.ok(!text.includes(action), `${action} is shown as a raw code`);
      assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\.[a-z_]+\b|\b[a-z]+\.[a-z]+_[a-z_]+\b/);
    }
  }
});

const ymdPlus = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function ownedParty(ws, name, due) {
  const id = await thirdParty(ws, name, { next_due_date: due });
  await db.prepare('UPDATE tp_third_parties SET team_owner_id=? WHERE id=?').run(managerId, id);
  return id;
}

test('a TPRM-only client: setup shows third-party risk and its scope, the sidebar has no ISO modules, ISO scoping is skipped', async () => {
  const ws = await workspace('Harbourline Shell Logistics', { tprm: true, scope: 'Freight brokers and couriers serving the UK depots' });
  for (const route of [`/workspaces/${ws}`, `/workspaces/${ws}/setup`]) {
    const page = await client.get(route);
    assert.equal(page.status, 200, route);
    assert.match(page.text, new RegExp(`data-tprm-workspace-setup="${ws}"`));
    assert.match(page.text, /Freight brokers and couriers serving the UK depots/, 'the scope typed at creation is shown');
    assert.doesNotMatch(page.text, /No assessment programme has been assigned|Enable ISO 27001 when the engagement is ready|0 of 0 steps/);
    assert.match(page.text, new RegExp(`href="/tprm/clients/${ws}"`), 'the register is one click away');
    const nav = page.text.slice(page.text.indexOf('class="sidebar-nav"'), page.text.indexOf('</nav>', page.text.indexOf('class="sidebar-nav"')));
    for (const iso of ['review-queue', 'risks', 'assurance', 'mrms', 'documents', 'audits', 'client-portal']) {
      assert.doesNotMatch(nav, new RegExp(`href="/workspaces/${ws}/${iso}"`), `no ${iso} in the sidebar`);
    }
    assert.match(nav, new RegExp(`href="/workspaces/${ws}/inbox"`));
    assert.match(nav, new RegExp(`href="/workspaces/${ws}/team"`));
  }
  const intake = await client.get(`/workspaces/${ws}/intake`);
  assert.equal(intake.status, 302);
  assert.equal(intake.location, `/workspaces/${ws}/setup`);
  const team = await client.get(`/workspaces/${ws}/team`);
  assert.equal(team.status, 200);
  assert.doesNotMatch(team.text, /Start gap assessment|Step 2 of 3|gap assessment won/);
});

test('ISO and unassigned clients keep their own setup pages and full sidebar', async () => {
  const iso = await workspace('Shell ISO Unchanged', { iso: true, scope: 'ISO scope text long enough' });
  const page = await client.get(`/workspaces/${iso}?skipSetupRedirect=1`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /data-tprm-workspace-setup/);
  for (const iso27 of ['review-queue', 'risks', 'assurance', 'mrms']) assert.match(page.text, new RegExp(`href="/workspaces/${iso}/${iso27}"`));
  assert.doesNotMatch(page.text, new RegExp(`href="/tprm/clients/${iso}"`));
  const both = await workspace('Shell Both Services', { iso: true, tprm: true, scope: 'ISO scope text long enough' });
  const bothPage = await client.get(`/workspaces/${both}?skipSetupRedirect=1`);
  assert.match(bothPage.text, new RegExp(`href="/workspaces/${both}/review-queue"`));
  assert.doesNotMatch(bothPage.text, new RegExp(`href="/tprm/clients/${both}"`));
  const unassigned = await workspace('Shell Unassigned Client');
  const un = await client.get(`/workspaces/${unassigned}`);
  assert.equal(un.status, 200);
  assert.match(un.text, /No assessment programme has been assigned/);
});

test('the inbox of a TPRM-only client lists its third-party work and no ISO nags; ISO clients keep theirs', async () => {
  const ws = await workspace('Inbox Harbourline Client', { tprm: true });
  await ownedParty(ws, 'PayNimbus Lapsed Inbox', '2020-01-15');
  const inbox = await client.get(`/workspaces/${ws}/inbox`);
  assert.equal(inbox.status, 200);
  assert.match(inbox.text, /Review overdue: PayNimbus Lapsed Inbox/);
  assert.doesNotMatch(inbox.text, /No completed management review on record|No internal audit on record/);
  const iso = await workspace('Inbox ISO Client', { iso: true });
  const isoInbox = await client.get(`/workspaces/${iso}/inbox`);
  assert.match(isoInbox.text, /No completed management review on record/);
  assert.doesNotMatch(isoInbox.text, /Review overdue/);
});

test('the quarterly access review reminder goes only to clients with an ISO programme', async () => {
  const jobs = require('../lib/jobs');
  const tp = await workspace('Reminder TPRM Client', { tprm: true });
  const iso = await workspace('Reminder ISO Client', { iso: true });
  const legacy = await workspace('Reminder Legacy Client', { iso: true });
  await db.prepare("UPDATE workspaces SET frameworks = '' WHERE id = ?").run(legacy);
  await jobs.jobAccessReviewKickoff();
  const count = async ws => (await db.prepare("SELECT COUNT(*)::int AS c FROM notifications WHERE workspace_id=? AND category='access_review_due'").get(ws)).c;
  assert.equal(await count(tp), 0);
  assert.equal(await count(iso), 1);
  assert.equal(await count(legacy), 1, 'a blank frameworks value is an ISO client, as everywhere else in the app');
});

test('portfolio leaves TPRM-only clients out of the ISO score and shows their third-party risk status', async () => {
  const ws = await workspace('Portfolio Harbourline Client', { tprm: true });
  await ownedParty(ws, 'Portfolio Lapsed Supplier', '2020-02-01');
  const page = await client.get('/portfolio');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, new RegExp(`onclick="location='/workspaces/${ws}'"`), 'not a scored engagement row');
  const row = page.text.slice(page.text.indexOf(`data-portfolio-tprm-client="${ws}"`));
  assert.ok(row.length > 0, 'listed with the third-party risk clients');
  assert.match(row.slice(0, 1500), /1 review overdue/);
  assert.match(page.text, /data-portfolio-tprm-note/);

  const dashboard = await client.get('/dashboard');
  const dashRow = dashboard.text.slice(dashboard.text.indexOf(`data-client-home="/tprm/clients/${ws}"`));
  assert.match(dashRow.slice(0, 3000), /1 review overdue/, 'the client list shows the lapsed review as needing attention');
});

test('the firm calendar and workload include third-party risk dates and work', async () => {
  const ws = await workspace('Calendar Harbourline Client', { tprm: true });
  const due = ymdPlus(10);
  await ownedParty(ws, 'Soonco Calendar Supplier', due);
  const month = await client.get(`/calendar?month=${due.slice(0, 7)}`);
  assert.equal(month.status, 200);
  assert.match(month.text, /Review due: Soonco Calendar Supplier/);
  assert.match(month.text, /Review due\s*<\/span>/, 'the legend names the new kind');
  assert.match(month.text, /\b\d+ review due\b/, 'it counts in the owner\'s workload');
});

test('searching inside a TPRM-only client offers no ISO controls or ISO pages', async () => {
  const ws = await workspace('Search Scope Harbour', { tprm: true });
  const iso = await workspace('Search Scope Atlas', { iso: true });
  const inTp = await search(client, 'access control', ws);
  assert.ok(!inTp.some(r => ['Control', 'Clause', 'Page'].includes(r.type)), JSON.stringify(inTp.map(r => r.type)));
  const inIso = await search(client, 'access control', iso);
  assert.ok(inIso.some(r => r.type === 'Control'), 'an ISO client still finds its controls');
});

test('firm-level pages give the page clock the firm\'s own zone, and a signed-out page gives none', async () => {
  const was = (await db.prepare('SELECT timezone FROM firms WHERE id=?').get(firmId)).timezone;
  await db.prepare("UPDATE firms SET timezone = 'Asia/Kolkata' WHERE id = ?").run(firmId);
  try {
    for (const path of ['/dashboard', '/portfolio']) {
      const page = await client.get(path);
      assert.equal(page.status, 200, path);
      assert.match(page.text, /<html lang="en"[^>]*data-time-zone="Asia\/Kolkata"/, `${path} stamps times in the firm's zone`);
    }
    const out = makeClient(env.app);
    sessions.push(out);
    assert.doesNotMatch((await out.get('/login')).text, /data-time-zone=/);
  } finally {
    await db.prepare('UPDATE firms SET timezone = ? WHERE id = ?').run(was, firmId);
  }
});

async function clientSession(email, ws, role = 'client_owner') {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active)
    VALUES (?,?,?,'client',1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email)).lastInsertRowid);
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(ws, id, role);
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${email} signs in`);
  sessions.push(session);
  return { id, session };
}

const helpOf = text => text.slice(text.indexOf('id="helpBackdrop"'), text.indexOf('id="toastStack"'));

test('a third-party-risk-only client denied a page outside its own portal gets help for its own services and its own zone, never another client\'s', async () => {
  const mine = await workspace('Denial Own TPRM Co', { tprm: true });
  const other = await workspace('Denial Other ISO Co', { iso: true, tprm: true });
  await db.prepare("UPDATE workspaces SET timezone = 'Asia/Kolkata' WHERE id = ?").run(mine);
  await db.prepare("UPDATE workspaces SET timezone = 'America/New_York' WHERE id = ?").run(other);
  const { session } = await clientSession('denial-tp-owner@test.local', mine);
  assert.equal((await session.get(`/workspaces/${mine}/client-portal/third-party-risk`)).status, 200);
  for (const path of [`/workspaces/${other}/client-portal`, `/workspaces/${other}/client-portal/third-party-risk`, `/tprm/clients/${other}`]) {
    const page = await session.get(path);
    assert.ok([403, 404].includes(page.status), `${path} is refused (${page.status})`);
    const help = helpOf(page.text);
    assert.match(help, /data-help-area="third-party-risk"/, `${path}: help names third-party risk`);
    assert.doesNotMatch(help, /data-help-area="(home|actions|progress|updates)"/, `${path}: no ISO portal areas`);
    assert.doesNotMatch(page.text, /America\/New_York/, `${path}: nothing of the other client's zone`);
    if (/<html lang="en"[^>]*data-time-zone=/.test(page.text)) assert.match(page.text, /<html lang="en"[^>]*data-time-zone="Asia\/Kolkata"/, `${path}: the clock uses the client's own zone`);
  }
  const shell = await session.get(`/workspaces/${other}/client-portal`);
  assert.match(shell.text, /<html lang="en"[^>]*data-time-zone="Asia\/Kolkata"/, 'the generic denial shell has the client\'s zone');
});

test('the firm help panel on a third-party-risk-only client offers no ISO shortcuts; an ISO client keeps them', async () => {
  const tpOnly = await workspace('Help TPRM Only Co', { tprm: true });
  const iso = await workspace('Help ISO Co', { iso: true, tprm: true });
  const only = helpOf((await client.get(`/tprm/clients/${tpOnly}`)).text);
  assert.match(only, /data-help-area="third-party-risk"/);
  assert.doesNotMatch(only, /Go to \(within a client\)|<span>Readiness<\/span>/);
  const ws = helpOf((await client.get(`/workspaces/${tpOnly}/setup`)).text);
  assert.doesNotMatch(ws, /Go to \(within a client\)/, 'the client\'s own workspace pages agree');
  const isoHelp = helpOf((await client.get(`/tprm/clients/${iso}`)).text);
  assert.match(isoHelp, /Go to \(within a client\)/);
  assert.match(isoHelp, /<span>Readiness<\/span>/);
});
