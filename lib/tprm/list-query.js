'use strict';

const SORTS = Object.freeze(['third_party', 'client', 'due', 'name']);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

const VALUE = Object.freeze({
  third_party: r => String(r.third_party_name || r.thirdPartyName || r.name || '').toLowerCase(),
  client: r => String(r.client_name || r.clientName || '').toLowerCase(),
  due: r => ymd(r.due_date || r.nextDueDate || r.due) || '9999',
  name: r => String(r.name || r.title || '').toLowerCase(),
});

function from(query = {}, path = '') {
  const q = String(query.q || '').trim().slice(0, 100);
  const sort = SORTS.includes(String(query.sort)) ? String(query.sort) : '';
  const dir = String(query.dir) === 'desc' ? 'desc' : 'asc';
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const href = over => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) if (typeof v === 'string' && v && !['toast', 'toastKind'].includes(k)) p.set(k, v);
    for (const [k, v] of Object.entries(over)) { if (v) p.set(k, v); else p.delete(k); }
    const s = p.toString();
    return path + (s ? `?${s}` : '');
  };
  return {
    q, sort, dir,
    rows(list, text) {
      const shown = (list || []).filter(r => words.every(w => String(text(r) || '').toLowerCase().includes(w)));
      if (!sort) return shown;
      const key = VALUE[sort];
      return shown.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    },
    th(key, label) {
      const aria = sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const next = sort === key && dir === 'asc' ? 'desc' : '';
      return `<th data-tp-sort="${esc(key)}" aria-sort="${aria}"><a class="tprm-sort" href="${esc(href({ sort: key, dir: next }))}">${esc(label)}</a></th>`;
    },
    row(r, text) {
      return `data-tp-row data-tp-text="${esc(String(text(r) || '').toLowerCase())}"`
        + SORTS.map(k => ` data-tp-sort-${k}="${esc(VALUE[k](r))}"`).join('');
    },
    form({ placeholder = 'Search', shown = 0, total = 0, hidden = {}, label = 'Search these lists' } = {}) {
      const keep = Object.entries(hidden).filter(([, v]) => v).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
      const order = (sort ? `<input type="hidden" name="sort" value="${esc(sort)}">` : '') + (sort && dir === 'desc' ? '<input type="hidden" name="dir" value="desc">' : '');
      return `<form method="GET" action="${esc(path)}" class="tprm-list-search" role="search" data-tp-list-controls>`
        + `<label class="sr-only" for="tp-list-q">${esc(label)}</label>`
        + `<input class="tpa-input" id="tp-list-q" type="search" name="q" value="${esc(q)}" placeholder="${esc(placeholder)}" autocomplete="off" data-tp-list-search>`
        + keep + order + '<button class="tpa-btn" type="submit">Search</button>'
        + `<span class="tpa-meta" data-tp-list-count data-tp-total="${Number(total) || 0}">Showing ${Number(shown) || 0} of ${Number(total) || 0}</span>`
        + (q || sort ? ` <a href="${esc(path)}${hidden.client ? `?client=${esc(hidden.client)}` : ''}" data-tp-list-clear>Clear</a>` : '')
        + '</form>';
    },
  };
}

module.exports = { SORTS, from };
