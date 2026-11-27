'use strict';

const DASH_CHAR = '\u2014';
const DASH_ENTITY = '&' + 'mdash;';
const DASH = new RegExp(`${DASH_CHAR}|${DASH_ENTITY}`, 'gi');
const HAS_DASH = new RegExp(`${DASH_CHAR}|${DASH_ENTITY}`, 'i');
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/y;
const RAW_TEXT = new Set(['script', 'style', 'textarea']);
const KEEP_TEXT = new Set(['pre', 'code']);
const ENDS_OPTION = new Set(['option', 'select', 'optgroup', 'datalist']);

function hasValueAttribute(tag) {
  return /\svalue(?:\s*=|[\s/>])/i.test(tag.replace(/"[^"]*"|'[^']*'/g, '""'));
}

function normalizeDisplayPunctuation(value) {
  if (typeof value !== 'string' || !HAS_DASH.test(value)) return value;
  const n = value.length;
  let lower = null;
  let out = '';
  let i = 0;
  let keepDepth = 0;
  let valuelessOption = false;
  while (i < n) {
    const lt = value.indexOf('<', i);
    const stop = lt === -1 ? n : lt;
    if (stop > i) {
      const text = value.slice(i, stop);
      out += keepDepth || valuelessOption ? text : text.replace(DASH, '-');
    }
    if (lt === -1) break;
    if (value.startsWith('<!--', lt)) {
      const close = value.indexOf('-->', lt + 4);
      const end = close === -1 ? n : close + 3;
      out += value.slice(lt, end);
      i = end;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(value);
    if (!m) {
      out += '<';
      i = lt + 1;
      continue;
    }
    const tag = m[0];
    const name = m[2].toLowerCase();
    const after = lt + tag.length;
    out += tag;
    i = after;
    if (m[1] === '/') {
      if (KEEP_TEXT.has(name) && keepDepth > 0) keepDepth--;
      if (ENDS_OPTION.has(name)) valuelessOption = false;
      continue;
    }
    if (ENDS_OPTION.has(name)) valuelessOption = name === 'option' && !hasValueAttribute(tag);
    if (RAW_TEXT.has(name) && !tag.endsWith('/>')) {
      if (lower === null) lower = value.toLowerCase();
      const close = lower.indexOf(`</${name}`, after);
      const end = close === -1 ? n : close;
      out += value.slice(after, end);
      i = end;
      continue;
    }
    if (KEEP_TEXT.has(name)) keepDepth++;
  }
  return out;
}

function confirmationName(value) {
  return String(value == null ? '' : value)
    .replace(/\u2014/g, '-')
    .normalize('NFC')
    .trim();
}

function confirmationMatchesRenderedName(submitted, stored) {
  return confirmationName(submitted) === confirmationName(stored);
}

module.exports = {
  normalizeDisplayPunctuation,
  confirmationName,
  confirmationMatchesRenderedName,
};
