'use strict';

const FIELD_LABELS = Object.freeze({
  name: 'The name of the person it goes to',
  client: 'The client',
  supplier: 'The third party',
  firm: 'Your firm',
  due: 'The due date',
  contact: 'The reviewer to write to, with their email',
});
const BASE_FIELDS = Object.freeze(['name', 'client', 'supplier', 'firm']);
const LINK_SCHEMES = /^(https:\/\/[^\s<>"']+|mailto:[^\s<>"'@]+@[^\s<>"']+)$/i;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif";

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function blocksOf(src) {
  const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  return text.split(/\n[ \t]*\n+/).map(b => b.replace(/^\n+|\n+$/g, '')).filter(b => b.trim()).map(b => {
    const lines = b.split('\n');
    if (lines.every(l => /^\s*- /.test(l))) return { type: 'list', items: lines.map(l => l.replace(/^\s*- /, '')) };
    return { type: 'para', lines };
  });
}

function tokens(line) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  for (let i = 0; i < line.length;) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && /[\\*[\]{}()-]/.test(line[i + 1])) { buf += line[i + 1]; i += 2; continue; }
    if (c === '{') {
      const m = /^\{([a-z_]{1,30})\}/i.exec(line.slice(i));
      if (m) { flush(); out.push({ t: 'field', v: m[1].toLowerCase(), raw: m[0] }); i += m[0].length; continue; }
    }
    if (c === '[') {
      const m = /^\[([^\]\n]+)\]\(([^)\s]*)\)/.exec(line.slice(i));
      if (m) { flush(); out.push({ t: 'link', label: tokens(m[1]), href: m[2] }); i += m[0].length; continue; }
    }
    if (c === '*' && line[i + 1] === '*') {
      const end = line.indexOf('**', i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'bold', kids: tokens(line.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if (c === '*' && line[i + 1] !== '*') {
      let end = -1;
      for (let j = i + 2; j < line.length; j += 1) {
        if (line[j] === '\\') { j += 1; continue; }
        if (line[j] === '*' && line[j - 1] !== '*' && line[j + 1] !== '*') { end = j; break; }
      }
      if (end > i + 1) { flush(); out.push({ t: 'italic', kids: tokens(line.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

function walk(list, fn) {
  for (const tk of list) {
    fn(tk);
    if (tk.kids) walk(tk.kids, fn);
    if (tk.label) walk(tk.label, fn);
  }
}

function allTokens(src) {
  const out = [];
  for (const b of blocksOf(src)) for (const line of (b.type === 'list' ? b.items : b.lines)) out.push(...tokens(line));
  return out;
}

function problems(src, allowed, where) {
  const errors = [];
  const ok = new Set(allowed);
  const seen = new Set();
  walk(allTokens(src), tk => {
    if (tk.t === 'field' && !ok.has(tk.v) && !seen.has(tk.raw)) {
      seen.add(tk.raw);
      errors.push(`${where}: ${tk.raw} is not something this email can fill in. Use ${allowed.map(f => `{${f}}`).join(', ')}.`);
    }
    if (tk.t === 'link' && !LINK_SCHEMES.test(tk.href)) {
      errors.push(`${where}: the link "${tk.href || '(empty)'}" must start with https:// or be mailto: followed by an email address.`);
    }
    if (tk.t === 'link') walk(tk.label, inner => { if (inner.t === 'link') errors.push(`${where}: a link cannot hold another link.`); });
  });
  return errors;
}

function lineProblems(src, allowed, where) {
  const errors = [];
  const ok = new Set(allowed);
  const seen = new Set();
  for (const m of String(src || '').matchAll(/\{([a-z_]{1,30})\}/gi)) {
    const f = m[1].toLowerCase();
    if (!ok.has(f) && !seen.has(m[0])) { seen.add(m[0]); errors.push(`${where}: ${m[0]} is not something this email can fill in. Use ${allowed.map(x => `{${x}}`).join(', ')}.`); }
  }
  return errors;
}

function fieldValues(d) {
  const c = d && d.contact && d.contact.email ? d.contact : null;
  return {
    name: d.toName || '', client: d.clientName || '', supplier: d.thirdPartyName || '', firm: d.firmName || '', due: d.until || d.dueDay || '',
    contact: c ? { name: c.name || '', email: c.email } : null,
  };
}

function fieldHtml(f, values) {
  if (f === 'contact') {
    const c = values.contact;
    if (!c) return esc(values.firm || 'us');
    const mail = `<a href="mailto:${esc(c.email)}" style="color:#1f3a5f;">${esc(c.email)}</a>`;
    return c.name ? `${esc(c.name)} at ${mail}` : mail;
  }
  return esc(values[f] || '');
}

function fieldText(f, values) {
  if (f === 'contact') {
    const c = values.contact;
    if (!c) return String(values.firm || 'us');
    return c.name ? `${c.name} at ${c.email}` : c.email;
  }
  return String(values[f] || '');
}

function inlineHtml(list, values, inLink = false) {
  return list.map(tk => {
    if (tk.t === 'text') return esc(tk.v);
    if (tk.t === 'field') return Object.prototype.hasOwnProperty.call(FIELD_LABELS, tk.v) ? (inLink && tk.v === 'contact' ? esc(fieldText(tk.v, values)) : fieldHtml(tk.v, values)) : esc(tk.raw);
    if (tk.t === 'bold') return `<strong>${inlineHtml(tk.kids, values, inLink)}</strong>`;
    if (tk.t === 'italic') return `<em>${inlineHtml(tk.kids, values, inLink)}</em>`;
    if (tk.t === 'link') {
      const label = inlineHtml(tk.label, values, true);
      if (!LINK_SCHEMES.test(tk.href) || inLink) return label;
      return `<a href="${esc(tk.href)}" style="color:#1f3a5f;">${label}</a>`;
    }
    return '';
  }).join('');
}

function inlineText(list, values) {
  return list.map(tk => {
    if (tk.t === 'text') return tk.v;
    if (tk.t === 'field') return Object.prototype.hasOwnProperty.call(FIELD_LABELS, tk.v) ? fieldText(tk.v, values) : tk.raw;
    if (tk.t === 'bold' || tk.t === 'italic') return inlineText(tk.kids, values);
    if (tk.t === 'link') {
      const label = inlineText(tk.label, values);
      if (!LINK_SCHEMES.test(tk.href)) return label;
      const target = tk.href.replace(/^mailto:/i, '');
      return label.trim() === target ? label : `${label} (${target})`;
    }
    return '';
  }).join('');
}

const PARA_STYLE = `margin:0 0 14px;font-size:14px;line-height:1.6;color:#1b1f24;font-family:${FONT};`;
const LIST_STYLE = `margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.6;color:#1b1f24;font-family:${FONT};`;

function toHtmlBlocks(src, d) {
  const values = fieldValues(d || {});
  return blocksOf(src).map(b => {
    if (b.type === 'list') return `<ul style="${LIST_STYLE}">${b.items.map(i => `<li style="margin:0 0 6px;">${inlineHtml(tokens(i), values)}</li>`).join('')}</ul>`;
    const html = b.lines.map(l => inlineHtml(tokens(l), values)).join('<br>');
    return html.replace(/<br>/g, '').trim() ? `<p style="${PARA_STYLE}">${html}</p>` : '';
  }).filter(Boolean);
}

function toText(src, d) {
  const values = fieldValues(d || {});
  return blocksOf(src).map(b => (b.type === 'list'
    ? b.items.map(i => `- ${inlineText(tokens(i), values)}`).join('\n')
    : b.lines.map(l => inlineText(tokens(l), values)).join('\n'))).join('\n\n');
}

function fillLine(src, d) {
  const values = fieldValues(d || {});
  return String(src || '').replace(/\{([a-z_]{1,30})\}/gi, (all, k) => {
    const f = k.toLowerCase();
    return Object.prototype.hasOwnProperty.call(FIELD_LABELS, f) ? fieldText(f, values) : all;
  }).replace(/[ \t]{2,}/g, ' ').trim();
}

function editorHtml(src) {
  return blocksOf(src).map(b => {
    const plain = list => list.map(tk => {
      if (tk.t === 'text') return esc(tk.v);
      if (tk.t === 'field') return esc(tk.raw);
      if (tk.t === 'bold') return `<b>${plain(tk.kids)}</b>`;
      if (tk.t === 'italic') return `<i>${plain(tk.kids)}</i>`;
      if (tk.t === 'link') return LINK_SCHEMES.test(tk.href) ? `<a href="${esc(tk.href)}">${plain(tk.label)}</a>` : `[${plain(tk.label)}](${esc(tk.href)})`;
      return '';
    }).join('');
    if (b.type === 'list') return `<ul>${b.items.map(i => `<li>${plain(tokens(i))}</li>`).join('')}</ul>`;
    return `<p>${b.lines.map(l => plain(tokens(l))).join('<br>')}</p>`;
  }).join('');
}

function fromPlain(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[\\*[\]]/g, m => `\\${m}`).replace(/^(\s*)- /, '$1\\- ')).join('\n');
}

module.exports = { FIELD_LABELS, BASE_FIELDS, LINK_SCHEMES, blocksOf, tokens, problems, lineProblems, toHtmlBlocks, toText, fillLine, editorHtml, fromPlain, fieldValues };
