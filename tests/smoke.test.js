const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iso27001-smoke-'));
const { createSuiteDatabase, openTestDb } = require('./pg-test-databases');
const { pgTools } = require('../lib/backup');
let suiteDb = null;
const ENV = { ...process.env, ISMS_KEY_FILE: path.join(TMP, 'master.key'), ISMS_BACKUP_DIR: path.join(TMP, 'backups'),
  SESSION_SECRET: 'smoke-test-fixed-secret-for-deterministic-cookies-only',
  DISABLE_CSRF: '1' };

const TEST_EMAIL = 'smoke@test.local';
const TEST_PASSWORD = 'smoke-test-password-1234';
const REVIEWER_EMAIL = 'smoke-reviewer@test.local';
const REVIEWER_PASSWORD = 'smoke-reviewer-password-1234';

let serverProc = null;
let port = 3344;
let assertions = 0, failures = 0;

function ok(name, cond, detail) {
  assertions++;
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
}

let cookieJar = '';
let csrfToken = null;

function captureResponse(res, body) {
  const sc = res.headers['set-cookie'];
  if (sc) {
    const newCookies = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]);
    const existing = cookieJar ? cookieJar.split('; ').filter(c => !newCookies.some(nc => nc.startsWith(c.split('=')[0] + '='))) : [];
    cookieJar = [...existing, ...newCookies].join('; ');
  }
  const m = body && body.match(/name="csrf-token" content="([a-f0-9]+)"/);
  if (m) csrfToken = m[1];
}

function get(pathStr) {
  return new Promise((resolve, reject) => {
    const headers = cookieJar ? { cookie: cookieJar } : {};
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'GET', headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { captureResponse(res, body); resolve({ status: res.statusCode, body, headers: res.headers }); });
    });
    req.on('error', reject);
    req.end();
  });
}

function post(pathStr, formObj) {
  return new Promise((resolve, reject) => {
    const payload = { ...formObj };
    if (csrfToken && !payload._csrf) payload._csrf = csrfToken;
    const body = Object.entries(payload).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map(vi => `${encodeURIComponent(k)}=${encodeURIComponent(vi)}`)
                       : [`${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`]
    ).join('&');
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    };
    if (cookieJar) headers['cookie'] = cookieJar;
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'POST', headers }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => { captureResponse(res, resp); resolve({ status: res.statusCode, body: resp, headers: res.headers }); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postMultipart(pathStr, fieldName, filename, content, contentType = 'text/plain') {
  return new Promise((resolve, reject) => {
    const boundary = `----nimbus-smoke-${Date.now().toString(16)}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(String(content)), tail]);
    const headers = {
      Accept: 'application/json',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    };
    if (cookieJar) headers.cookie = cookieJar;
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'POST', headers }, res => {
      let resp = '';
      res.on('data', chunk => { resp += chunk; });
      res.on('end', () => { captureResponse(res, resp); resolve({ status: res.statusCode, body: resp, headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return true; } catch (_) {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function startServer() {
  suiteDb = await createSuiteDatabase();
  ENV.DATABASE_URL = suiteDb.url;
  console.log(`smoke.test: building a seeded database (${suiteDb.name})…`);
  const build = require('child_process').spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'build-test-db.js'), suiteDb.url],
    { env: { ...process.env, ISMS_KEY_FILE: ENV.ISMS_KEY_FILE }, stdio: ['ignore', 'ignore', 'pipe'] });
  if (build.status !== 0) throw new Error('build-test-db failed:\n' + build.stderr);

  const bcrypt = require('bcrypt');
  const seedConn = await openTestDb(suiteDb.url);
  const firm = await seedConn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  if (!firm) {
    await seedConn.prepare(`INSERT INTO firms (name) VALUES (?)`).run('Smoke Test Firm');
  }
  const firmId = firm ? firm.id : (await seedConn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  const hash = bcrypt.hashSync(TEST_PASSWORD, 4);
  const existing = await seedConn.prepare('SELECT id FROM users WHERE email=?').get(TEST_EMAIL);
  if (existing) {
    await seedConn.prepare(`UPDATE users SET password_hash=?, active=1, firm_role='manager', firm_id=?, user_type='firm' WHERE id=?`)
      .run(hash, firmId, existing.id);
  } else {
    await seedConn.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active)
                      VALUES (?, ?, 'Smoke Tester', ?, 'firm', 'manager', 1)`)
      .run(TEST_EMAIL, hash, firmId);
  }
  const reviewerHash = bcrypt.hashSync(REVIEWER_PASSWORD, 4);
  const existingReviewer = await seedConn.prepare('SELECT id FROM users WHERE email=?').get(REVIEWER_EMAIL);
  if (existingReviewer) {
    await seedConn.prepare(`UPDATE users SET password_hash=?, active=1, firm_role='manager', firm_id=?, user_type='firm' WHERE id=?`)
      .run(reviewerHash, firmId, existingReviewer.id);
  } else {
    await seedConn.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active)
                      VALUES (?, ?, 'Smoke Independent Reviewer', ?, 'firm', 'manager', 1)`)
      .run(REVIEWER_EMAIL, reviewerHash, firmId);
  }
  await seedConn.close();

  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...ENV, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  const ready = await waitFor(async () => (await get('/login')).status < 500);
  if (!ready) throw new Error('server did not start within 8s');

  const loginRes = await loginAs(TEST_EMAIL, TEST_PASSWORD);
  if (loginRes.status < 300 || loginRes.status >= 400) {
    throw new Error(`login failed: expected 3xx, got ${loginRes.status}. Body preview: ${(loginRes.body || '').slice(0, 200)}`);
  }
}

async function loginAs(email, password) {
  cookieJar = '';
  csrfToken = null;
  await get('/login');
  return post('/login', { email, password });
}

function stopServer() {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
}

async function dropSuiteDatabase() {
  if (!suiteDb) return;
  try { await pgTools.dropDatabase(process.env.PG_TEST_URL, suiteDb.name); }
  catch (error) { console.error(`smoke.test: could not drop ${suiteDb.name}: ${error.message}`); }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  console.log(`smoke tests in ${TMP}\n`);
  try {
    await startServer();

    console.log('boot');
    const home = await get('/dashboard');
    ok('GET /dashboard renders the firm portfolio', home.status === 200 && home.body.includes('Portfolio'), `got ${home.status}`);
    const dash = await get('/dashboard?legacy=1');
    ok('retained Clients page returns 200', dash.status === 200, `got ${dash.status}`);

    const dbDiscover = await openTestDb(suiteDb.url);
    const firm = await dbDiscover.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    let wsRow = firm ? await dbDiscover.prepare('SELECT id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1').get(firm.id) : null;
    if (!wsRow) wsRow = await dbDiscover.prepare('SELECT id, firm_id FROM workspaces ORDER BY id LIMIT 1').get();
    await dbDiscover.close();
    if (!wsRow) throw new Error('no workspace in seeded DB to test against');
    const wsId = wsRow.id;
    if (wsRow.firm_id && firm && wsRow.firm_id !== firm.id) {
      await post(`/tenants/${wsRow.firm_id}/switch`, {});
    }
    console.log(`  (using workspace id=${wsId})`);

    console.log('\nworkspace pages');
    for (const [pathStr, name] of [
      [`/workspaces/${wsId}/controls/assess/clause-4.1`, 'wizard renders for clause-4.1'],
      [`/workspaces/${wsId}/controls/assess/annex-a.5.1`, 'wizard renders for annex-a.5.1'],
      [`/workspaces/${wsId}/controls/assess/summary`, 'post-assessment summary renders'],
      [`/workspaces/${wsId}/soa`, 'SoA renders'],
      [`/workspaces/${wsId}/risks`, 'risks list renders'],
      [`/workspaces/${wsId}/tasks`, 'tasks list renders'],
      [`/workspaces/${wsId}/readiness/blockers`, 'blockers page renders'],
      [`/workspaces/${wsId}/export/soa.csv`, 'SoA CSV exports']
    ]) {
      const r = await get(pathStr);
      ok(name, r.status === 200, `got ${r.status} for ${pathStr}`);
    }

    console.log('\nstarter risk library');
    const starterRisk = require(path.join(ROOT, 'data', 'risk-library'))[0];
    const starterBeforeDb = await openTestDb(suiteDb.url);
    const starterBefore = (await starterBeforeDb.prepare('SELECT COUNT(*) c FROM risks WHERE workspace_id=?').get(wsId)).c;
    await starterBeforeDb.close();
    const addStarterRisk = await post(`/workspaces/${wsId}/risks/library`, { pick: '0' });
    ok('starter risk selection reaches its dedicated import route',
      addStarterRisk.status >= 300 && addStarterRisk.status < 400 && /^\/workspaces\/\d+\/risks\?toast=/.test(addStarterRisk.headers.location || ''),
      `got ${addStarterRisk.status} ${addStarterRisk.headers.location || ''}`);
    const starterAfterDb = await openTestDb(suiteDb.url);
    const starterAfter = (await starterAfterDb.prepare('SELECT COUNT(*) c FROM risks WHERE workspace_id=?').get(wsId)).c;
    const insertedStarter = await starterAfterDb.prepare('SELECT id FROM risks WHERE workspace_id=? AND title=? ORDER BY id DESC LIMIT 1').get(wsId, starterRisk.title);
    const starterAudit = await starterAfterDb.prepare("SELECT id FROM audit_log WHERE workspace_id=? AND action='add_risks_from_library' ORDER BY id DESC LIMIT 1").get(wsId);
    await starterAfterDb.close();
    ok('selected starter risk is inserted into the register', starterAfter === starterBefore + 1 && !!insertedStarter,
      `before=${starterBefore}, after=${starterAfter}, title=${starterRisk.title}`);
    ok('starter risk import retains an audit record', !!starterAudit, 'add_risks_from_library audit entry missing');

    console.log('\nretired third-party risk module');
    const retiredVendors = await get(`/workspaces/${wsId}/vendors`);
    ok('the retired supplier register is no longer routed', retiredVendors.status === 404, `got ${retiredVendors.status}`);
    const retiredDdq = await get('/supplier-ddq/' + '0'.repeat(64));
    ok('the retired public vendor DDQ link is no longer routed', retiredDdq.status === 404, `got ${retiredDdq.status}`);
    const tprmArea = await get('/tprm');
    ok('the third-party risk menu entry opens the firm-level TPRM area', tprmArea.status === 200 && /data-tprm-area/.test(tprmArea.body) && !/coming soon/i.test(tprmArea.body), `got ${tprmArea.status}`);

    console.log('\nbespoke question coverage');
    const { getQuestions } = require(path.join(ROOT, 'data', 'assessment-questions'));
    const db = await openTestDb(suiteDb.url);
    const items = await db.prepare('SELECT id, title, evidence_needed FROM iso_items').all();
    let mech = 0;
    for (const it of items) {
      const qs = getQuestions(it);
      if (!qs || qs.length === 0) mech++;
      for (const q of qs || []) if (/^Are you doing this:/.test(q)) mech++;
    }
    ok('all 118 items return bespoke questions (no mechanical fallthrough)', items.length === 118 && mech === 0, `${items.length} items, ${mech} mechanical`);

    console.log('\nwizard POST + history snapshot');
    const before = (await db.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND iso_item_id='clause-5.1'`).get(wsId)).c;
    const assessmentVersion = (await db.prepare("SELECT record_version FROM v_control_states WHERE workspace_id=? AND iso_item_id='clause-5.1'").get(wsId))?.record_version || 0;
    await db.close();
    const saveResp = await post(`/workspaces/${wsId}/controls/assess/clause-5.1`, {
      expected_record_version: assessmentVersion,
      status: 'Partially Implemented',
      maturity: 2,
      scope_pct: 70,
      notes: 'smoke-test note',
      action: 'save',
      q_0: 'yes', q_1: 'partial', q_2: 'no'
    });
    ok('wizard POST returns 3xx redirect', saveResp.status >= 300 && saveResp.status < 400, `got ${saveResp.status}`);
    const dbCheck = await openTestDb(suiteDb.url);
    const after = (await dbCheck.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND iso_item_id='clause-5.1'`).get(wsId)).c;
    ok('history snapshot was appended', after === before + 1, `before=${before}, after=${after}`);
    const cur = await dbCheck.prepare(`SELECT status, scope_pct, notes FROM v_control_states WHERE workspace_id=? AND iso_item_id='clause-5.1'`).get(wsId);
    ok('control state status persisted (converged)', cur && cur.status === 'Partially Implemented', JSON.stringify(cur));
    ok('control state scope_pct persisted (converged)', cur && cur.scope_pct === 70, JSON.stringify(cur));
    ok('control state notes persisted (converged)', cur && cur.notes === 'smoke-test note', JSON.stringify(cur));
    await dbCheck.close();

    console.log('\ncontrol history page');
    const histResp = await get(`/workspaces/${wsId}/controls/clause-5.1/history`);
    ok('history page renders', histResp.status === 200, `got ${histResp.status}`);
    ok('history page lists the snapshot', histResp.body.includes('Partially Implemented'), 'snapshot row missing');
    ok('history page shows scope %', histResp.body.includes('70%'), 'scope % missing');

    console.log('\nbulk-spawn priority derivation');
    const spawnResp = await post(`/workspaces/${wsId}/controls/assess/summary/spawn-tasks`, {
      iso_id: ['clause-5.1'],
      due_date: ''
    });
    ok('spawn-tasks returns 3xx redirect', spawnResp.status >= 300 && spawnResp.status < 400, `got ${spawnResp.status}`);
    const dbTask = await openTestDb(suiteDb.url);
    const tasks = await dbTask.prepare(`SELECT priority, iso_item_id FROM tasks WHERE workspace_id=? AND iso_item_id='clause-5.1' ORDER BY id DESC LIMIT 1`).get(wsId);
    ok('task created with priority field', tasks && ['low','normal','high','critical'].includes(tasks.priority), JSON.stringify(tasks));
    await dbTask.close();

    console.log('\nSoA shows risk linkage');
    const soaResp = await get(`/workspaces/${wsId}/soa`);
    ok('SoA includes "Risks treated" header', soaResp.body.includes('Risks treated'), 'header missing');

    console.log('\nfirm manager surfaces');
    const portfolioResp = await get('/portfolio');
    ok('GET /portfolio returns 200', portfolioResp.status === 200, `got ${portfolioResp.status}`);
    ok('portfolio renders the health board', portfolioResp.body.includes('Portfolio health'), 'heading missing');

    const agenda = await get('/calendar');
    ok('compliance calendar renders', agenda.status === 200 && agenda.body.includes('Calendar'), `got ${agenda.status}`);
    const calYear = await get('/calendar?legacy=1');
    ok('GET /calendar (year overview) returns 200', calYear.status === 200, `got ${calYear.status}`);
    ok('year view renders the connected month grid', calYear.body.includes('mc-year'), 'mc-year grid missing');
    ok('year view renders the 3 month rows', calYear.body.includes('mc-yrow'), 'mc-yrow rows missing');

    const calMonth = await get('/calendar?month=2026-05&legacy=1');
    ok('GET /calendar?month= (month detail) returns 200', calMonth.status === 200, `got ${calMonth.status}`);
    ok('month view renders the weekday day-grid header', calMonth.body.includes('mc-cal-head'), 'mc-cal-head missing');

    const wsCal = await get(`/workspaces/${wsId}/calendar`);
    ok('GET /workspaces/:id/calendar returns 200', wsCal.status === 200, `got ${wsCal.status}`);

    const glossary = await get('/glossary');
    ok('GET /glossary returns 200', glossary.status === 200, `got ${glossary.status}`);
    ok('glossary renders the firm sidebar with Glossary active',
       glossary.body.includes('href="/glossary" class="nav-item active"'),
       'firm-level active Glossary nav item missing');
    ok('glossary did not inherit the client sidebar',
       !glossary.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /glossary');

    const playbooks = await get('/playbooks');
    ok('GET /playbooks returns 200', playbooks.status === 200, `got ${playbooks.status}`);
    ok('playbooks renders the firm sidebar with Playbooks active',
       playbooks.body.includes('href="/playbooks" class="nav-item active"'),
       'firm-level active Playbooks nav item missing');
    ok('playbooks did not inherit the client sidebar',
       !playbooks.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /playbooks');

    const playbookDetail = await get('/playbooks/kickoff');
    ok('GET /playbooks/:id (detail) returns 200', playbookDetail.status === 200, `got ${playbookDetail.status}`);
    ok('playbook detail did not inherit the client sidebar',
       playbookDetail.body.includes('href="/playbooks" class="nav-item active"') &&
       !playbookDetail.body.includes('>Compliance calendar<'),
       'playbook detail did not render the firm sidebar');

    const firmLib = await get('/firm/library');
    ok('GET /firm/library returns 200', firmLib.status === 200, `got ${firmLib.status}`);
    ok('firm library renders the firm sidebar with Library active',
       firmLib.body.includes('href="/firm/library" class="nav-item active"'),
       'firm-level active Library nav item missing');
    ok('firm library did not inherit the client sidebar',
       !firmLib.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /firm/library');

    const firmLibRisks = await get('/firm/library/risks');
    ok('GET /firm/library/risks returns 200', firmLibRisks.status === 200, `got ${firmLibRisks.status}`);
    ok('firm library risks did not inherit the client sidebar',
       firmLibRisks.body.includes('href="/firm/library" class="nav-item active"') &&
       !firmLibRisks.body.includes('>Compliance calendar<'),
       'firm library risks did not render the firm sidebar');

    const adminEmail = await get('/admin/email');
    ok('GET /admin/email returns 200 (managers allowed)', adminEmail.status === 200, `got ${adminEmail.status}`);
    ok('admin email renders the firm sidebar with Admin email active',
       adminEmail.body.includes('href="/admin/email" class="nav-item active"'),
       'firm-level active Admin email nav item missing');
    ok('admin email did not inherit the client sidebar',
       !adminEmail.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /admin/email');

  } catch (e) {
    failures++;
    console.error(`\n✗ test crashed: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    stopServer();
    await dropSuiteDatabase();
    console.log(`\n${assertions} assertions, ${failures} failure${failures === 1 ? '' : 's'}`);
    process.exit(failures > 0 ? 1 : 0);
  }
})();
