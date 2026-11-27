'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'site-enhancements.js'), 'utf8');

function fakeElement(tag = 'div') {
  const attrs = new Map();
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(),
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
      contains: c => classes.has(c),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: k => attrs.delete(k),
    hasAttribute: k => attrs.has(k),
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    prepend(child) { child.parentNode = el; el.children.unshift(child); },
    append(...c) { c.forEach(x => el.appendChild(x)); },
    before() {},
    remove() {},
    insertAdjacentElement() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
  return el;
}

function harness() {
  const observers = [];
  const timers = [];
  const html = fakeElement('html');
  const body = fakeElement('body');
  body.dataset.authenticated = 'true';
  html.appendChild(body);
  const state = { app: null, toggles: [] };
  const document = {
    readyState: 'complete',
    cookie: '',
    documentElement: html,
    body,
    title: '',
    getElementById: id => (id === 'app' ? state.app : null),
    querySelector: () => null,
    querySelectorAll: sel => (sel === '[data-theme-toggle]' ? state.toggles : []),
    createElement: tag => fakeElement(tag),
    addEventListener() {},
  };
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
    disconnect() { this.targets = []; }
  }
  const window = { addEventListener() {}, location: { pathname: '/', search: '', protocol: 'http:' } };
  const context = vm.createContext({
    document, window, MutationObserver,
    location: window.location,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame: fn => fn(),
    HTMLElement: function HTMLElement() {},
    HTMLInputElement: function HTMLInputElement() {},
    HTMLSelectElement: function HTMLSelectElement() {},
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
    HTMLFormElement: function HTMLFormElement() {},
    URLSearchParams,
    console,
  });
  const flush = () => { while (timers.length) timers.shift()(); };
  return { context, document, observers, state, body, html, flush };
}

function makeApp(h) {
  const app = fakeElement('div');
  const toggle = fakeElement('button');
  toggle.setAttribute('data-theme-toggle', '');
  toggle.setAttribute('aria-label', 'Switch to dark mode');
  toggle.title = 'Switch to dark mode';
  app.appendChild(toggle);
  h.body.appendChild(app);
  h.state.app = app;
  h.state.toggles = [toggle];
  return { app, toggle };
}

test('the theme toggle label is re-synced after the whole app shell is swapped', () => {
  const h = harness();
  h.html.setAttribute('data-theme', 'dark');
  const first = makeApp(h);
  vm.runInContext(SOURCE, h.context);
  assert.equal(first.toggle.getAttribute('aria-label'), 'Switch to light mode', 'the first page is synced on load');

  const second = makeApp(h);
  for (const o of h.observers) {
    for (const { target } of o.targets) {
      if (target === h.body || target === h.html) o.cb([{ type: 'childList' }]);
    }
  }
  h.flush();
  assert.equal(second.toggle.getAttribute('aria-label'), 'Switch to light mode',
    'the swapped-in toggle reads the current dark theme instead of its server default');
  const watchingNew = h.observers.some(o => o.targets.some(t => t.target === second.app && t.options.subtree));
  assert.ok(watchingNew, 'page changes inside the new shell are observed again');
});
