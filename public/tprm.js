(function () {
  'use strict';

  var dialog = null;
  var pending = null;

  function field(form, name) {
    var el = form.querySelector('input[type="hidden"][name="' + name + '"]');
    return el ? el.value : '';
  }

  function buildDialog() {
    var d = document.createElement('dialog');
    d.className = 'tp-dialog';
    d.setAttribute('aria-labelledby', 'tpDialogTitle');
    d.setAttribute('aria-describedby', 'tpDialogBody');
    d.innerHTML = '<form method="dialog" class="tp-dialog-form">'
      + '<h2 class="tp-dialog-title" id="tpDialogTitle"></h2>'
      + '<p class="tp-dialog-body" id="tpDialogBody"></p>'
      + '<div class="tp-dialog-actions">'
      + '<button class="tp-btn" value="cancel" type="submit" data-tp-dialog-cancel>Cancel</button>'
      + '<button class="tp-btn tp-btn--primary" value="confirm" type="submit" data-tp-dialog-confirm></button>'
      + '</div></form>';
    document.body.appendChild(d);
    d.addEventListener('close', function () {
      var p = pending;
      pending = null;
      if (!p || d.returnValue !== 'confirm') { if (p && p.focus) p.focus.focus(); return; }
      var flag = document.createElement('input');
      flag.type = 'hidden'; flag.name = '_tp_confirmed'; flag.value = '1';
      p.form.appendChild(flag);
      p.form.dataset.tpConfirmed = '1';
      if (p.submitter && typeof p.form.requestSubmit === 'function') p.form.requestSubmit(p.submitter);
      else if (typeof p.form.requestSubmit === 'function') p.form.requestSubmit();
      else p.form.submit();
    });
    return d;
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.querySelector || form.dataset.tpConfirmed === '1') return;
    var title = field(form, '_tp_confirm_title');
    if (!title || typeof HTMLDialogElement === 'undefined') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!dialog) dialog = buildDialog();
    dialog.querySelector('.tp-dialog-title').textContent = title;
    var body = field(form, '_tp_confirm_body');
    var bodyEl = dialog.querySelector('.tp-dialog-body');
    bodyEl.textContent = body;
    bodyEl.hidden = !body;
    var yes = dialog.querySelector('[data-tp-dialog-confirm]');
    yes.textContent = field(form, '_tp_confirm_action') || 'Confirm';
    yes.className = 'tp-btn ' + (field(form, '_tp_confirm_tone') === 'problem' ? 'tp-btn--problem' : 'tp-btn--primary');
    pending = { form: form, submitter: event.submitter || null, focus: event.submitter || document.activeElement };
    dialog.returnValue = '';
    dialog.showModal();
    dialog.querySelector('[data-tp-dialog-cancel]').focus();
  }, true);

  var LIST_KEY = 'tprm-list:';
  function cleanSearch(search) {
    var p = new URLSearchParams(search);
    p.delete('toast'); p.delete('toastKind');
    return p;
  }
  function keyFor(pathname, params) { return LIST_KEY + pathname + '|' + (params.get('view') || ''); }
  function remember(pathname, params) {
    var meaningful = Array.from(params.keys()).some(function (k) { return k !== 'view'; });
    try {
      if (meaningful) localStorage.setItem(keyFor(pathname, params), '?' + params.toString());
      else localStorage.removeItem(keyFor(pathname, params));
    } catch (_) {}
  }
  function recalled(pathname, params) {
    try { return localStorage.getItem(keyFor(pathname, params)) || ''; } catch (_) { return ''; }
  }
  (function restore() {
    if (!document.querySelector('[data-tp-list]')) return;
    var params = cleanSearch(location.search);
    if (Array.from(params.keys()).some(function (k) { return k !== 'view'; })) return;
    var saved = recalled(location.pathname, params);
    if (saved && saved.charAt(0) === '?') location.replace(location.pathname + saved + location.hash);
  })();
  document.addEventListener('click', function (event) {
    var clear = event.target.closest ? event.target.closest('[data-tprm-clear-filters], [data-tp-list-clear]') : null;
    if (!clear) return;
    var u = new URL(clear.href, location.href);
    try { localStorage.removeItem(keyFor(u.pathname, cleanSearch(u.search))); } catch (_) {}
  });

  function setQuery(pairs) {
    var url = new URL(location.href);
    Object.keys(pairs).forEach(function (k) { if (pairs[k]) url.searchParams.set(k, pairs[k]); else url.searchParams.delete(k); });
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    remember(url.pathname, cleanSearch(url.search));
  }

  function initList(list) {
    var rows = Array.prototype.slice.call(list.querySelectorAll('[data-tp-row]'));
    var body = rows.length ? rows[0].parentNode : null;
    var controls = document.querySelector('[data-tp-list-controls]');
    var count = document.querySelector('[data-tp-list-count]');
    var total = count ? Number(count.getAttribute('data-tp-total')) || rows.length : rows.length;
    var search = controls ? controls.querySelector('[data-tp-list-search]') : null;
    var serverQ = search ? search.value.trim().toLowerCase() : '';
    var timer = null;
    remember(location.pathname, cleanSearch(location.search));
    function applySearch() {
      var q = search.value.trim().toLowerCase();
      if (serverQ && q.indexOf(serverQ) === -1) {
        clearTimeout(timer);
        timer = setTimeout(function () {
          var url = new URL(location.href);
          if (q) url.searchParams.set('q', search.value.trim()); else url.searchParams.delete('q');
          remember(url.pathname, cleanSearch(url.search));
          location.assign(url.pathname + url.search);
        }, 400);
        return;
      }
      var shown = 0;
      rows.forEach(function (row) {
        var hit = !q || (row.getAttribute('data-tp-text') || row.textContent.toLowerCase()).indexOf(q) !== -1;
        row.hidden = !hit;
        if (hit) shown += 1;
      });
      if (count) {
        var all = document.querySelectorAll('[data-tp-list] [data-tp-row]');
        var visible = Array.prototype.filter.call(all, function (r) { return !r.hidden; }).length;
        count.textContent = 'Showing ' + (document.querySelectorAll('[data-tp-list]').length > 1 ? visible : shown) + ' of ' + total;
      }
      setQuery({ q: search.value.trim() });
    }
    if (search) search.addEventListener('input', applySearch);
    if (controls) {
      Array.prototype.forEach.call(controls.querySelectorAll('select'), function (sel) {
        sel.addEventListener('change', function () {
          var url = new URL(location.href);
          if (sel.value) url.searchParams.set(sel.name, sel.value); else url.searchParams.delete(sel.name);
          url.searchParams.delete('toast'); url.searchParams.delete('toastKind');
          remember(url.pathname, cleanSearch(url.search));
          if (window.AppPageLoader) window.AppPageLoader.show();
          location.assign(url.pathname + url.search);
        });
      });
    }
    Array.prototype.forEach.call(list.querySelectorAll('th[data-tp-sort]'), function (th) {
      var link = th.querySelector('a');
      if (!link || !body) return;
      link.addEventListener('click', function (event) {
        event.preventDefault();
        var key = th.getAttribute('data-tp-sort');
        var dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
        Array.prototype.forEach.call(list.querySelectorAll('th[data-tp-sort]'), function (other) { other.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', dir);
        var attr = 'data-tp-sort-' + key;
        rows.sort(function (a, b) {
          var x = a.getAttribute(attr) || '', y = b.getAttribute(attr) || '';
          var nx = Number(x), ny = Number(y);
          var c = (x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny)) ? nx - ny : x.localeCompare(y, 'en', { sensitivity: 'base' });
          return dir === 'ascending' ? c : -c;
        });
        rows.forEach(function (row) { body.appendChild(row); });
        setQuery({ sort: key, dir: dir === 'ascending' ? 'asc' : 'desc' });
      });
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-tp-list]'), initList);

  function sizeText(n) {
    if (n < 1024) return n + ' bytes';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function initFile(box) {
    var input = box.querySelector('input[type="file"]');
    if (!input) return;
    box.classList.add('tp-file--on');
    var note = document.createElement('p');
    note.className = 'tp-file-note';
    note.setAttribute('aria-live', 'polite');
    note.textContent = input.multiple ? 'Drop files here, or choose them.' : 'Drop a file here, or choose one.';
    box.appendChild(note);
    function describe() {
      var files = Array.prototype.slice.call(input.files || []);
      note.textContent = files.length ? files.map(function (f) { return f.name + ', ' + sizeText(f.size); }).join('; ')
        : (input.multiple ? 'Drop files here, or choose them.' : 'Drop a file here, or choose one.');
    }
    input.addEventListener('change', describe);
    ['dragenter', 'dragover'].forEach(function (t) {
      box.addEventListener(t, function (e) { e.preventDefault(); box.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      box.addEventListener(t, function (e) { e.preventDefault(); box.classList.remove('is-over'); });
    });
    box.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      try { input.files = e.dataTransfer.files; } catch (_) { return; }
      describe();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    var form = input.form;
    if (!form || form.dataset.tpUpload === 'on' || typeof FormData === 'undefined') return;
    form.dataset.tpUpload = 'on';
    form.addEventListener('submit', function (event) {
      if (event.defaultPrevented || !Array.prototype.some.call(form.querySelectorAll('input[type="file"]'), function (i) { return i.files && i.files.length; })) return;
      event.preventDefault();
      var data = new FormData(form);
      if (event.submitter && event.submitter.name) data.append(event.submitter.name, event.submitter.value);
      var xhr = new XMLHttpRequest();
      xhr.open((form.getAttribute('method') || 'POST').toUpperCase(), form.action);
      xhr.timeout = 150000;
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable && e.loaded < e.total) note.textContent = 'Uploading, ' + Math.round((e.loaded / e.total) * 100) + '%';
      });
      xhr.upload.addEventListener('load', function () {
        note.textContent = 'Uploaded. Checking the file, this can take a moment.';
      });
      xhr.addEventListener('timeout', function () {
        note.textContent = 'The server did not answer in time. Reload the page to see whether the file was saved, then try again if it was not.';
      });
      xhr.addEventListener('load', function () {
        var posted = new URL(form.action, location.href).href.split('#')[0];
        if (xhr.status < 400 && xhr.responseURL && xhr.responseURL.split('#')[0] !== posted) { location.assign(xhr.responseURL); return; }
        document.open(); document.write(xhr.responseText); document.close();
      });
      xhr.addEventListener('error', function () { note.textContent = 'The upload did not reach the server. Nothing was saved: check the connection and try again.'; });
      note.textContent = 'Uploading, 0%';
      xhr.send(data);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-tp-file]'), initFile);

  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('[data-tp-preview]') : null;
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var holder = link.parentNode.querySelector(':scope > .tp-preview');
    if (holder) { holder.remove(); link.setAttribute('aria-expanded', 'false'); return; }
    var src = link.getAttribute('data-tp-preview');
    holder = document.createElement('div');
    holder.className = 'tp-preview';
    var isImage = /\.(png|jpe?g|gif|webp)$/i.test(link.textContent.trim()) || link.getAttribute('data-tp-preview-kind') === 'image';
    var el = document.createElement(isImage ? 'img' : 'iframe');
    el.src = src;
    if (isImage) el.alt = link.textContent.trim(); else el.title = link.textContent.trim();
    holder.appendChild(el);
    link.insertAdjacentElement('afterend', holder);
    link.setAttribute('aria-expanded', 'true');
  }, true);
  var bench = document.querySelector('[data-tprm-workbench]');
  if (bench) (function () {
    bench.classList.add('tpw-js', 'tpw-saving');
    var keys = document.querySelector('[data-tprm-keys]');
    if (keys) keys.hidden = false;
    var items = Array.prototype.slice.call(bench.querySelectorAll('[data-tprm-answer-item]'));
    var panes = {};
    Array.prototype.forEach.call(bench.querySelectorAll('[data-tprm-answer-pane]'), function (p) { panes[p.getAttribute('data-tprm-answer-pane')] = p; });
    var current = null;
    var token = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';

    function select(id, opts) {
      if (!panes[id]) return;
      if (current && current !== id && panes[current]) {
        var leaving = panes[current].querySelector('[data-tprm-conclusion-form][data-tprm-json]');
        if (leaving && typeof saveComment === 'function') saveComment(leaving);
      }
      current = id;
      Object.keys(panes).forEach(function (k) { panes[k].classList.toggle('is-current', k === id); });
      items.forEach(function (a) {
        var on = a.getAttribute('data-tprm-answer-id') === id;
        a.classList.toggle('is-current', on);
        if (on) { a.setAttribute('aria-current', 'true'); if (opts && opts.scrollList) a.scrollIntoView({ block: 'nearest' }); } else a.removeAttribute('aria-current');
      });
      if (opts && opts.hash !== false && history.replaceState) history.replaceState(null, '', '#answer-' + id);
      var top = bench.getBoundingClientRect().top;
      if (opts && opts.scrollPage && top < 0) window.scrollBy(0, top);
      var first = panes[id].querySelector('[data-tp-preview]:not([aria-expanded="true"])');
      if (first && !panes[id].querySelector('.tp-preview')) first.click();
    }
    var fromHash = /^#answer-(\d+)$/.exec(location.hash);
    select(fromHash && panes[fromHash[1]] ? fromHash[1] : (items[0] && items[0].getAttribute('data-tprm-answer-id')), { hash: false });

    bench.addEventListener('click', function (event) {
      var a = event.target.closest ? event.target.closest('[data-tprm-answer-item]') : null;
      if (!a || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      select(a.getAttribute('data-tprm-answer-id'), { scrollPage: true });
    });

    function move(step) {
      var ids = items.map(function (a) { return a.getAttribute('data-tprm-answer-id'); });
      var at = ids.indexOf(current);
      var next = ids[Math.min(ids.length - 1, Math.max(0, at + step))];
      if (next && next !== current) select(next, { scrollList: true, scrollPage: true });
    }

    document.addEventListener('keydown', function (event) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      var t = event.target;
      if (t && (t.isContentEditable || /^(textarea|select)$/i.test(t.tagName)
        || (/^input$/i.test(t.tagName) && !/^(radio|checkbox|button|submit)$/i.test(t.type)))) return;
      if (document.querySelector('dialog[open]')) return;
      var pane = current && panes[current];
      var k = event.key;
      if (k === 'j' || k === 'J') { event.preventDefault(); move(1); return; }
      if (k === 'k' || k === 'K') { event.preventDefault(); move(-1); return; }
      if (!pane) return;
      if (k === '1' || k === '2' || k === '3') {
        var radio = pane.querySelector('input[type="radio"][data-tprm-key="' + k + '"]');
        if (radio && !radio.checked) { event.preventDefault(); radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
        return;
      }
      if (k === 'c' || k === 'C') {
        var ask = pane.querySelector('[data-tprm-ask-clarification]');
        if (ask) { event.preventDefault(); ask.open = true; var box = ask.querySelector('textarea'); if (box) box.focus(); }
        return;
      }
      if (k === 'f' || k === 'F') {
        var raise = pane.querySelector('[data-tprm-raise-finding]');
        if (raise) { event.preventDefault(); location.assign(raise.href); }
      }
    });

    var queues = {};
    function stateEl(form) { return form.querySelector('[data-tprm-save-state]'); }
    function say(form, text, tone) {
      var el = stateEl(form);
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('tpa-tone-problem', tone === 'problem');
    }
    function updateClose(data) {
      var close = document.querySelector('[data-tprm-close-review-form]');
      if (!close || !data.questionnaire) return;
      var rv = close.querySelector('input[name="row_version"]');
      if (rv) rv.value = data.questionnaire.row_version;
      var b = data.blockers || {};
      var btn = close.querySelector('[data-tprm-close-review]');
      if (btn) btn.disabled = !!(b.unreviewed || b.unclosed || b.unchecked);
    }
    function updateItem(id, data) {
      var a = bench.querySelector('[data-tprm-answer-id="' + id + '"] [data-tprm-item-conclusion]');
      if (a) {
        a.textContent = data.answer.conclusion_label;
        a.className = 'tpa-status tpa-tone-' + ({ unsatisfactory: 'problem', partially_satisfactory: 'attention' }[data.answer.conclusion] || 'quiet');
      }
      if (panes[id]) panes[id].setAttribute('data-tprm-answer-conclusion', data.answer.conclusion);
    }
    function save(form) {
      var id = form.closest('[data-tprm-answer-pane]').getAttribute('data-tprm-answer-pane');
      var run = function () {
        var chosen = form.querySelector('input[name="conclusion"]:checked');
        if (!chosen) { say(form, 'Choose a conclusion to save the comment.'); return Promise.resolve(); }
        var body = {
          conclusion: chosen.value,
          comment: (form.querySelector('textarea[name="comment"]') || {}).value || '',
          row_version: form.querySelector('input[name="row_version"]').value,
        };
        say(form, 'Saving');
        return fetch(form.getAttribute('data-tprm-json'), {
          method: 'POST', credentials: 'same-origin', redirect: 'manual',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': token },
          body: JSON.stringify(body),
        }).then(function (res) {
          var type = res.headers.get('content-type') || '';
          if (res.type === 'opaqueredirect' || type.indexOf('application/json') === -1) {
            say(form, 'Not saved: your session may have ended. Reload the page and make the change again.', 'problem');
            return null;
          }
          return res.json().then(function (data) {
            if (!data.ok) { say(form, 'Not saved: ' + data.error, 'problem'); return; }
            form.querySelector('input[name="row_version"]').value = data.answer.row_version;
            say(form, data.answer.reviewed_line ? data.answer.conclusion_label + ', by ' + data.answer.reviewed_line + '. Saved.' : data.message);
            updateItem(id, data);
            updateClose(data);
          });
        }, function () { say(form, 'Not saved: the server could not be reached. Check the connection and try again.', 'problem'); });
      };
      queues[id] = (queues[id] || Promise.resolve()).then(run, run);
      return queues[id];
    }
    function saveComment(form) {
      var comment = form.querySelector('textarea[name="comment"]');
      if (comment && comment.value !== comment.getAttribute('data-saved')) {
        comment.setAttribute('data-saved', comment.value);
        save(form);
      }
    }
    Array.prototype.forEach.call(bench.querySelectorAll('[data-tprm-conclusion-form][data-tprm-json]'), function (form) {
      var comment = form.querySelector('textarea[name="comment"]');
      if (comment) {
        comment.setAttribute('data-saved', comment.value);
        comment.addEventListener('blur', function () { saveComment(form); });
      }
      form.addEventListener('change', function (event) {
        if (event.target.name !== 'conclusion') return;
        if (comment) comment.setAttribute('data-saved', comment.value);
        save(form);
      });
      form.addEventListener('submit', function (event) { event.preventDefault(); if (comment) comment.setAttribute('data-saved', comment.value); save(form); });
    });
  })();

  (function () {
    var forms = Array.prototype.slice.call(document.querySelectorAll('form[data-tp-unsaved]'));
    if (!forms.length) return;
    var dirty = false, leaving = false;
    forms.forEach(function (form) {
      form.addEventListener('input', function () { dirty = true; });
      form.addEventListener('change', function () { dirty = true; });
      form.addEventListener('submit', function () { leaving = true; });
    });
    window.addEventListener('beforeunload', function (event) {
      if (dirty && !leaving) { event.preventDefault(); event.returnValue = ''; }
    });
  })();
})();
