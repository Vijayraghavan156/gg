'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'tprm.js'), 'utf8');
const footer = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'footer.ejs'), 'utf8');
const ORIGIN = 'http://tprm.fixture';
const BASE = '/tprm/clients/1/third-parties/2/assessments/3';
let browser;

function bench(ids, { prefix = '' } = {}) {
  const items = ids.map(id => `<li><a class="tpw-item" href="#answer-${id}" data-tprm-answer-item="Q-${id}" data-tprm-answer-id="${id}">${prefix}Q-${id}</a></li>`).join('');
  const panes = ids.map(id => `<section data-tprm-answer-pane="${id}"><h3>${prefix}Answer ${id}</h3>
    <a href="${BASE}?step=review&amp;answers=all&amp;raise=${id}#answer-${id}" data-tprm-raise-finding>Raise finding</a>
    <a href="${BASE}?step=review#answer-${ids[0]}" data-tprm-jump>Back to first</a></section>`).join('');
  return `<div data-tprm-workbench><ul>${items}</ul><div class="tpw-panes">${panes}</div></div><p hidden data-tprm-keys>Keys</p>`;
}

function page(main, { toast = false } = {}) {
  const reader = toast ? `<script>(function(){var p=new URLSearchParams(location.search);if(p.has('toast')){window.appPageToast={message:p.get('toast'),kind:p.get('toastKind')||'success'};p.delete('toast');p.delete('toastKind');history.replaceState({},'',location.pathname+(p.toString()?'?'+p:'')+location.hash);}})();</script>` : '';
  return `<!doctype html><html><head><meta name="csrf-token" content="x"><script src="/tprm.js" defer></script></head>
    <body><div class="app"><main class="main">${main}</main></div>${reader}</body></html>`;
}

async function fixture(routes) {
  const p = await browser.newPage();
  const seen = [];
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.setRequestInterception(true);
  p.on('request', r => {
    const u = new URL(r.url());
    if (u.pathname === '/tprm.js') return r.respond({ status: 200, contentType: 'text/javascript', body: script });
    if (r.isNavigationRequest()) seen.push(u.pathname + u.search);
    const body = routes(u);
    return r.respond({ status: 200, contentType: 'text/html', body: body || page('<p>Other page</p>') });
  });
  return { p, seen, errors };
}

const current = p => p.evaluate(() => (document.querySelector('[data-tprm-answer-pane].is-current') || {}).getAttribute?.('data-tprm-answer-pane') || null);

test.before(async () => {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.CHROME_PATH || (fs.existsSync(macChrome) ? macChrome : null);
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  browser = executablePath ? await puppeteer.launch({ executablePath, headless: true, args }) : await require('puppeteer').launch({ headless: 'shell', args });
});
test.after(async () => { await browser?.close(); });

test('Raise finding on Review of answers opens the page with the finding form instead of only reselecting the answer', async () => {
  const { p, seen } = await fixture(u => (u.searchParams.get('raise') ? page(`<form data-raise-form>Finding form for ${u.searchParams.get('raise')}</form>`) : page(bench(['5', '6']))));
  try {
    await p.goto(`${ORIGIN}${BASE}?step=review&answers=all#answer-6`, { waitUntil: 'load' });
    assert.equal(await current(p), '6');
    await Promise.all([p.waitForNavigation(), p.click('[data-tprm-answer-pane="6"] [data-tprm-raise-finding]')]);
    assert.ok(seen.some(s => s.includes('raise=6')), 'the raise page is requested');
    assert.ok(await p.$('[data-raise-form]'), 'the finding form is shown');
  } finally { await p.close(); }
});

test('an answer link on the same step and filter still just selects that answer', async () => {
  const { p, seen } = await fixture(() => page(bench(['5', '6'])));
  try {
    await p.goto(`${ORIGIN}${BASE}?step=review&answers=all#answer-6`, { waitUntil: 'load' });
    await p.click('[data-tprm-answer-pane="6"] [data-tprm-jump]');
    assert.equal(await current(p), '5');
    assert.equal(seen.length, 1, 'no new page load');
  } finally { await p.close(); }
});

test('after an in-app page swap the answer list responds again and the old page does not take the clicks', async () => {
  const { p, errors } = await fixture(() => page(bench(['5', '6'])));
  try {
    await p.goto(`${ORIGIN}${BASE}?step=review&answers=all`, { waitUntil: 'load' });
    assert.equal(await current(p), '5');
    await p.evaluate(html => {
      const main = document.querySelector('.main');
      const next = document.createElement('main');
      next.className = 'main';
      next.innerHTML = html;
      main.replaceWith(next);
      history.pushState({}, '', location.pathname + '?step=review&answers=all&raise=6#answer-6');
      document.dispatchEvent(new CustomEvent('app:page-swapped'));
    }, bench(['5', '6', '7'], { prefix: 'New ' }));
    assert.equal(await current(p), '6', 'the swapped page selects the answer in the address');
    assert.equal(await p.$eval('[data-tprm-keys]', el => el.hidden), false, 'the keyboard hint is shown again');
    await p.click('[data-tprm-answer-item][data-tprm-answer-id="7"]');
    assert.equal(await current(p), '7');
    await p.keyboard.press('k');
    assert.equal(await current(p), '6');
    assert.equal(await p.$$eval('[data-tprm-answer-pane].is-current', els => els.length), 1);
    assert.deepEqual(errors, []);
  } finally { await p.close(); }
});

test('a remembered register filter keeps the confirmation message when it reloads the page', async () => {
  const listPath = '/tprm/clients/1';
  const { p, seen } = await fixture(u => page(`<div data-tp-list><table><tbody><tr data-tp-row><td>Row</td></tr></tbody></table></div><p data-query>${u.search}</p>`, { toast: true }));
  try {
    await p.goto(`${ORIGIN}${listPath}?tier=high`, { waitUntil: 'load' });
    await p.goto(`${ORIGIN}${listPath}?toast=Imported%203%20third%20parties`, { waitUntil: 'networkidle0' });
    const landed = seen[seen.length - 1];
    assert.match(landed, /tier=high/, 'the remembered filter is applied');
    assert.equal(new URLSearchParams(landed.split('?')[1]).get('toast'), 'Imported 3 third parties', 'the message travels with it');
  } finally { await p.close(); }
});

test('the live list filter ignores accents in the words typed and in the rows', async () => {
  const rows = '<tr data-tp-row data-tp-text="soci&eacute;t&eacute; g&eacute;n&eacute;rale"><td>Soci&eacute;t&eacute; G&eacute;n&eacute;rale</td></tr><tr data-tp-row data-tp-text="acme hosting"><td>Acme Hosting</td></tr>';
  const { p } = await fixture(() => page(`<div data-tp-list-controls><input data-tp-list-search value=""></div><p data-tp-list-count data-tp-total="2"></p><div data-tp-list><table><tbody>${rows}</tbody></table></div>`));
  try {
    await p.goto(`${ORIGIN}/tprm/clients/1`, { waitUntil: 'load' });
    await p.type('[data-tp-list-search]', 'SOCIETE');
    const shown = await p.$$eval('[data-tp-row]', els => els.filter(e => !e.hidden).map(e => e.textContent.trim()));
    assert.deepEqual(shown, ['Société Générale']);
  } finally { await p.close(); }
});

test('saving a conclusion in place updates the step menu count and the filter counts', async () => {
  const p = await browser.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.setRequestInterception(true);
  const pane = `<section data-tprm-answer-pane="5"><form data-tprm-conclusion-form data-tprm-json="${BASE}/answers/5/conclusion.json">
    <input type="hidden" name="row_version" value="1"><label><input type="radio" name="conclusion" value="satisfactory"> Satisfactory</label>
    <span data-tprm-save-state></span></form></section>`;
  const main = `<nav data-tprm-steps><a data-tprm-step="review"><span class="tprm-rail-state"><span class="sr-only">In progress: </span><span data-tprm-unreviewed-note>3 answers without a conclusion</span>, 1 Brevis suggestion to decide</span></a></nav>
    <nav data-tprm-answer-filters><a data-tprm-answer-filter="unexpected">Needs judgement<span class="tpa-filter-n"> 3</span></a><strong data-tprm-answer-filter-current="all">All<span class="tpa-filter-n"> 4</span></strong><a data-tprm-answer-filter="not_reviewed">No conclusion<span class="tpa-filter-n"> 3</span></a></nav>
    <div data-tprm-workbench><ul><li><a data-tprm-answer-item="Q-5" data-tprm-answer-id="5" href="#answer-5"><span data-tprm-item-conclusion>Not reviewed</span></a></li></ul><div class="tpw-panes">${pane}</div></div>`;
  p.on('request', r => {
    const u = new URL(r.url());
    if (u.pathname === '/tprm.js') return r.respond({ status: 200, contentType: 'text/javascript', body: script });
    if (r.method() === 'POST') {
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'Saved: Satisfactory',
        answer: { id: 5, row_version: 2, conclusion: 'satisfactory', conclusion_label: 'Satisfactory', reviewed_line: null },
        questionnaire: { id: 1, status: 'under_review', row_version: 4 }, blockers: { unreviewed: 2, unclosed: 0, unchecked: 0, unsent: 0 },
        filterCounts: { unexpected: 3, ai: 0, all: 4, not_reviewed: 2 } }) });
    }
    return r.respond({ status: 200, contentType: 'text/html', body: page(main) });
  });
  try {
    await p.goto(`${ORIGIN}${BASE}?step=review&answers=all`, { waitUntil: 'load' });
    await p.click('[data-tprm-answer-pane="5"] input[value="satisfactory"]');
    await p.waitForFunction(() => document.querySelector('[data-tprm-unreviewed-note]').textContent.startsWith('2 '), { timeout: 5000 });
    assert.equal(await p.$eval('[data-tprm-steps] .tprm-rail-state', el => el.textContent), 'In progress: 2 answers without a conclusion, 1 Brevis suggestion to decide');
    assert.equal(await p.$eval('[data-tprm-answer-filter="not_reviewed"] .tpa-filter-n', el => el.textContent), ' 2');
    assert.equal(await p.$eval('[data-tprm-answer-filter-current="all"] .tpa-filter-n', el => el.textContent), ' 4');
    assert.deepEqual(errors, []);
  } finally { await p.close(); }
});

test('the page navigator tells page scripts about a swap and loads the page fully when it needs other head assets', () => {
  assert.match(footer, /dispatchEvent\(new CustomEvent\('app:page-swapped'/);
  assert.match(footer, /if \(needsHeadAssets\(newDoc\)\) return false;/);
  assert.match(footer, /if \(!ok\) \{ leavingDocument = true; window\.location\.reload\(\); return; \}/, 'the address already shows the new page, so it is reloaded, even with a #fragment');
  assert.match(footer, /window\.appPageToast = \{ message: msg, kind \}/);
  assert.match(script, /document\.addEventListener\('app:page-swapped', initPage\)/);
});

test('the register table scrolls sideways at laptop width instead of being clipped, and so do the third-party tabs', async () => {
  const css = ['app.css', 'tprm.css'].map(f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')).join('\n');
  const cols = Array.from({ length: 13 }, (_, i) => `<th>Column heading ${i}</th>`).join('');
  const cells = Array.from({ length: 13 }, (_, i) => `<td>Value number ${i} here</td>`).join('');
  const tabs = ['Overview', 'Assessments', 'Issues', 'Conditions', 'Documents', 'Contracts', 'Services', 'People', 'Subprocessors', 'Exit plans', 'Early reassessment', 'History']
    .map(t => `<a class="subtab" href="#">${t} <span>3</span></a>`).join('');
  const html = `<!doctype html><html><head><style>${css}</style></head><body><div class="app"><main class="main"><div class="main-inner">
    <nav class="subtabs tprm-tabs">${tabs}</nav>
    <div class="panel"><div class="table-scroll"><table class="t tprm-register-table"><thead><tr>${cols}</tr></thead><tbody><tr>${cells}</tr></tbody></table></div></div>
    </div></main></div></body></html>`;
  const p = await browser.newPage();
  try {
    await p.setViewport({ width: 1152, height: 800 });
    await p.setContent(html);
    const box = await p.$eval('.table-scroll', el => ({ overflow: getComputedStyle(el).overflowX, scroll: el.scrollWidth, client: el.clientWidth }));
    assert.equal(box.overflow, 'auto');
    assert.ok(box.scroll > box.client, 'the table is wider than its box and can be scrolled to');
    const tabsBox = await p.$eval('.tprm-tabs', el => ({ overflow: getComputedStyle(el).overflowX, right: el.getBoundingClientRect().right }));
    assert.equal(tabsBox.overflow, 'auto');
    assert.ok(tabsBox.right <= 1152, 'the tab strip stays inside the page');
  } finally { await p.close(); }
});

test('the page footer clock names its zone and uses the page zone when the page gives one', async () => {
  const enh = fs.readFileSync(path.join(__dirname, '..', 'public', 'site-enhancements.js'), 'utf8');
  const p = await browser.newPage();
  try {
    await p.setRequestInterception(true);
    p.on('request', r => {
      if (new URL(r.url()).pathname === '/site-enhancements.js') return r.respond({ status: 200, contentType: 'text/javascript', body: enh });
      return r.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en" data-time-zone="Asia/Kolkata"><head><script src="/site-enhancements.js" defer></script></head><body><div class="app" id="app"><main class="main"><div class="main-inner"><h1>Page</h1></div></main></div></body></html>' });
    });
    await p.goto(`${ORIGIN}/tprm`, { waitUntil: 'load' });
    await p.waitForSelector('.app-page-meta time');
    const text = await p.$eval('.app-page-meta time', el => el.textContent);
    assert.match(text, /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} [ap]m IST$/);
  } finally { await p.close(); }
});

test('a confirmation message is used once: a later in-app swap to a list with a remembered filter does not show it again', async () => {
  const listPath = '/tprm/clients/1';
  const { p, seen } = await fixture(u => page(`<div data-tp-list><table><tbody><tr data-tp-row><td>Row</td></tr></tbody></table></div><p data-query>${u.search}</p>`, { toast: true }));
  try {
    await p.goto(`${ORIGIN}${listPath}?tier=high`, { waitUntil: 'load' });
    await p.goto(`${ORIGIN}/tprm/clients/1/third-parties/9?toast=Saved`, { waitUntil: 'load' });
    await p.evaluate(() => {
      history.pushState({}, '', '/tprm/clients/1');
      const main = document.querySelector('.main');
      const next = document.createElement('main');
      next.className = 'main';
      next.innerHTML = '<div data-tp-list><table><tbody><tr data-tp-row><td>Row</td></tr></tbody></table></div>';
      main.replaceWith(next);
      document.dispatchEvent(new CustomEvent('app:page-swapped'));
    });
    await p.waitForFunction(() => /tier=high/.test(location.search));
    assert.equal(new URLSearchParams(seen[seen.length - 1].split('?')[1]).get('toast'), null, 'the old message is not carried along');
  } finally { await p.close(); }
});
