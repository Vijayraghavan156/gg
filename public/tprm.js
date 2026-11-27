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
  function withPageToast(query) {
    var shown = window.appPageToast;
    var p = new URLSearchParams(query);
    var own = new URLSearchParams(location.search);
    var message = own.get('toast') || (shown && shown.message) || '';
    var kind = own.get('toastKind') || (shown && shown.kind) || '';
    if (message) p.set('toast', message);
    if (message && kind && kind !== 'success') p.set('toastKind', kind);
    var text = p.toString();
    return text ? '?' + text : '';
  }
  function restore() {
    if (!document.querySelector('[data-tp-list]')) return false;
    var params = cleanSearch(location.search);
    if (Array.from(params.keys()).some(function (k) { return k !== 'view'; })) return false;
    var saved = recalled(location.pathname, params);
    if (!saved || saved.charAt(0) !== '?') return false;
    location.replace(location.pathname + withPageToast(saved.slice(1)) + location.hash);
    return true;
  }
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
    if (list.dataset.tpListOn === '1') return;
    list.dataset.tpListOn = '1';
    var rows = Array.prototype.slice.call(list.querySelectorAll('[data-tp-row]'));
    var body = rows.length ? rows[0].parentNode : null;
    var controls = document.querySelector('[data-tp-list-controls]');
    var count = document.querySelector('[data-tp-list-count]');
    var total = count ? Number(count.getAttribute('data-tp-total')) || rows.length : rows.length;
    var search = controls ? controls.querySelector('[data-tp-list-search]') : null;
    var fold = function (v) { var t = String(v || ''); return (t.normalize ? t.normalize('NFD') : t).replace(/[\u0300-\u036f]/g, '').toLowerCase(); };
    var serverQ = search ? fold(search.value.trim()) : '';
    var timer = null;
    remember(location.pathname, cleanSearch(location.search));
    function applySearch() {
      var q = fold(search.value.trim());
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
        var hit = !q || fold(row.getAttribute('data-tp-text') || row.textContent).indexOf(q) !== -1;
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

  function sizeText(n) {
    if (n < 1024) return n + ' bytes';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function initFile(box) {
    var input = box.querySelector('input[type="file"]');
    if (!input || box.classList.contains('tp-file--on')) return;
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
  var wb = null;
  function liveBench() { return wb && document.contains(wb.root) ? wb : null; }
  function initBench(bench) {
    if (!bench || bench.dataset.tpBenchOn === '1') return;
    bench.dataset.tpBenchOn = '1';
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
      if (opts && (opts.reveal || (opts.scrollPage && top < 0))) bench.scrollIntoView({ block: 'start' });
      var panesBox = bench.querySelector('.tpw-panes');
      if (panesBox && opts && opts.scrollPage) panesBox.scrollTop = 0;
      var first = panes[id].querySelector('[data-tp-preview]:not([aria-expanded="true"])');
      if (first && !panes[id].querySelector('.tp-preview')) {
        var scroller = document.querySelector('.main');
        var keep = scroller && !(opts && opts.reveal) ? scroller.scrollTop : null;
        first.click();
        var frame = panes[id].querySelector('.tp-preview iframe');
        if (frame && keep != null) {
          var hold = function () { if (Math.abs(scroller.scrollTop - keep) > 2) scroller.scrollTo({ top: keep, behavior: 'instant' }); };
          var stop = function () { scroller.removeEventListener('scroll', hold); };
          scroller.addEventListener('scroll', hold);
          ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) { window.addEventListener(ev, stop, { once: true, capture: true }); });
          setTimeout(stop, 2500);
        }
      }
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
    function updateCounts(data) {
      var note = document.querySelector('[data-tprm-unreviewed-note]');
      if (note && data.blockers) {
        var n = Number(data.blockers.unreviewed) || 0;
        note.textContent = n + ' answer' + (n === 1 ? '' : 's') + ' without a conclusion';
      }
      if (!data.filterCounts) return;
      Object.keys(data.filterCounts).forEach(function (f) {
        var el = document.querySelector('[data-tprm-answer-filter="' + f + '"] .tpa-filter-n, [data-tprm-answer-filter-current="' + f + '"] .tpa-filter-n');
        if (el) el.textContent = ' ' + data.filterCounts[f];
      });
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
            updateCounts(data);
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
    wb = { root: bench, panes: panes, select: select, move: move, current: function () { return current; } };
  }

  function answerLinkTarget(link, b) {
    var m = /#answer-(\d+)$/.exec(link.getAttribute('href') || '');
    if (!m || !b.panes[m[1]]) return null;
    var to = new URL(link.href, location.href);
    if (to.pathname !== location.pathname) return null;
    var here = new URLSearchParams(location.search);
    var there = new URLSearchParams(to.search);
    var step = here.get('step');
    if ((there.get('step') || step) !== step) return null;
    var differs = Array.from(there.keys()).some(function (k) { return k !== 'step' && there.get(k) !== here.get(k); });
    return differs ? null : m[1];
  }
  document.addEventListener('click', function (event) {
    var b = liveBench();
    if (!b) return;
    var link = event.target.closest ? event.target.closest('a[href*="#answer-"]') : null;
    if (!link || link.hasAttribute('data-tprm-answer-item') || event.metaKey || event.ctrlKey || event.shiftKey) return;
    var id = answerLinkTarget(link, b);
    if (!id) return;
    event.preventDefault();
    b.select(id, { scrollList: true, scrollPage: true, reveal: true });
  }, true);
  window.addEventListener('hashchange', function () {
    var b = liveBench();
    var h = /^#answer-(\d+)$/.exec(location.hash);
    if (b && h && b.panes[h[1]] && h[1] !== b.current()) b.select(h[1], { scrollList: true, scrollPage: true, reveal: true, hash: false });
  });
  document.addEventListener('keydown', function (event) {
    var b = liveBench();
    if (!b || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    var t = event.target;
    if (t && (t.isContentEditable || /^(textarea|select)$/i.test(t.tagName)
      || (/^input$/i.test(t.tagName) && !/^(radio|checkbox|button|submit)$/i.test(t.type)))) return;
    if (document.querySelector('dialog[open]')) return;
    var pane = b.current() && b.panes[b.current()];
    var k = event.key;
    if (k === 'j' || k === 'J') { event.preventDefault(); b.move(1); return; }
    if (k === 'k' || k === 'K') { event.preventDefault(); b.move(-1); return; }
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

  var unsaved = { dirty: false, leaving: false };
  function initUnsaved() {
    unsaved = { dirty: false, leaving: false };
    var state = unsaved;
    Array.prototype.forEach.call(document.querySelectorAll('form[data-tp-unsaved]'), function (form) {
      if (form.dataset.tpUnsavedOn === '1') return;
      form.dataset.tpUnsavedOn = '1';
      form.addEventListener('input', function () { state.dirty = true; });
      form.addEventListener('change', function () { state.dirty = true; });
      form.addEventListener('submit', function () { state.leaving = true; });
    });
  }
  window.addEventListener('beforeunload', function (event) {
    if (unsaved.dirty && !unsaved.leaving && document.querySelector('form[data-tp-unsaved]')) { event.preventDefault(); event.returnValue = ''; }
  });

  function initEmailEditor() {
    var form = document.querySelector('form[data-tprm-email-editor]');
    if (!form || !document.execCommand || form.dataset.tpEditorOn === '1') return;
    form.dataset.tpEditorOn = '1';
    var frame = document.querySelector('[data-tprm-email-frame]');
    var stateNote = document.querySelector('[data-tprm-email-state]');
    var showButtons = Array.prototype.slice.call(document.querySelectorAll('[data-tprm-email-show]'));
    var mode = 'html';
    var SAFE = /^(https:\/\/[^\s<>"']+|mailto:[^\s<>"'@]+@[^\s<>"']+)$/i;

    function escText(t) { return t.replace(/[\\*[\]]/g, function (m) { return '\\' + m; }); }
    function inline(n) {
      if (n.nodeType === 3) return escText(n.nodeValue.replace(/ /g, ' ').replace(/\n/g, ' '));
      if (n.nodeType !== 1) return '';
      var tag = n.nodeName.toLowerCase();
      if (tag === 'br') return '\n';
      var inner = Array.prototype.map.call(n.childNodes, inline).join('');
      var st = n.getAttribute('style') || '';
      var bold = tag === 'b' || tag === 'strong' || /font-weight:\s*(bold|[6-9]00)/i.test(st);
      var ital = tag === 'i' || tag === 'em' || /font-style:\s*italic/i.test(st);
      var href = tag === 'a' ? (n.getAttribute('href') || '') : '';
      var wrap = function (s, mark) {
        var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
        return m[2] ? m[1] + mark + m[2] + mark + m[3] : s;
      };
      if (ital) inner = wrap(inner, '*');
      if (bold) inner = wrap(inner, '**');
      if (href && inner.trim()) inner = '[' + inner + '](' + href.replace(/\)/g, '%29').replace(/\s/g, '%20') + ')';
      return inner;
    }
    function toMarkup(root) {
      var blocks = [], cur = '';
      function flush() { var t = cur.replace(/[ \t]+\n/g, '\n').replace(/^\n+|\n+$/g, ''); if (t.trim()) blocks.push(t); cur = ''; }
      function walk(n) {
        Array.prototype.forEach.call(n.childNodes, function (c) {
          var tag = c.nodeType === 1 ? c.nodeName.toLowerCase() : '';
          if (/^(p|div|h[1-6]|blockquote)$/.test(tag)) { flush(); walk(c); flush(); }
          else if (tag === 'ul' || tag === 'ol') {
            flush();
            var items = Array.prototype.filter.call(c.childNodes, function (li) { return li.nodeType === 1; })
              .map(function (li) { return inline(li).replace(/\n+/g, ' ').trim(); }).filter(Boolean);
            if (items.length) blocks.push(items.map(function (i) { return '- ' + i; }).join('\n'));
          } else cur += inline(c);
        });
      }
      walk(root);
      flush();
      return blocks.join('\n\n');
    }

    var previewUrl = (showButtons[0] && showButtons[0].getAttribute('formaction')) || '';
    var token = (form.elements._csrf && form.elements._csrf.value) || '';
    var asked = 0;
    function preview() {
      if (!previewUrl || !frame || !window.fetch || !window.URLSearchParams) return;
      var body = new URLSearchParams();
      ['subject', 'headline', 'opening', 'closing'].forEach(function (name) { body.append(name, form.elements[name] ? form.elements[name].value : ''); });
      body.append('as', mode);
      var mine = ++asked;
      showButtons.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-tprm-email-show') === mode ? 'true' : 'false'); });
      fetch(previewUrl, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': token }, body: body.toString() })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then(function (html) {
          if (mine !== asked) return;
          var next = document.createElement('iframe');
          next.className = frame.className;
          next.name = frame.name;
          next.title = frame.title;
          next.setAttribute('sandbox', '');
          next.setAttribute('data-tprm-email-frame', '');
          next.srcdoc = html;
          frame.parentNode.replaceChild(next, frame);
          frame = next;
          if (stateNote) stateNote.textContent = 'Sample details. The preview follows your typing; nothing is saved until you press Save.';
        })
        .catch(function () { if (stateNote) stateNote.textContent = 'The preview could not be refreshed. Your wording is still here; press Save when ready.'; });
    }
    var timer = null;
    function later() { clearTimeout(timer); timer = setTimeout(preview, 500); }
    showButtons.forEach(function (b) {
      b.addEventListener('click', function (event) { event.preventDefault(); mode = b.getAttribute('data-tprm-email-show'); preview(); });
    });

    var lastRange = null, lastBox = null;
    function remember(box) {
      var sel = window.getSelection();
      if (sel && sel.rangeCount && box.contains(sel.getRangeAt(0).commonAncestorContainer)) { lastRange = sel.getRangeAt(0).cloneRange(); lastBox = box; }
    }
    function restore(box) {
      box.focus();
      if (lastRange && lastBox === box) { var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(lastRange); }
    }

    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}
    Array.prototype.forEach.call(form.querySelectorAll('[data-tprm-email-region]'), function (region) {
      var box = region.querySelector('[data-tprm-email-rich]');
      var src = region.querySelector('[data-tprm-email-src]');
      var tools = region.querySelector('[data-tprm-email-tools]');
      if (!box || !src || !tools) return;
      box.hidden = false; tools.hidden = false;
      region.classList.add('fx-email-on');
      box.setAttribute('contenteditable', 'true');
      var label = region.querySelector('label');
      if (label) label.addEventListener('click', function (event) { event.preventDefault(); box.focus(); });
      function sync() { src.value = toMarkup(box); later(); }
      box.addEventListener('input', sync);
      ['keyup', 'mouseup', 'blur'].forEach(function (ev) { box.addEventListener(ev, function () { remember(box); }); });
      box.addEventListener('paste', function (event) {
        var text = event.clipboardData && event.clipboardData.getData('text/plain');
        if (text == null) return;
        event.preventDefault();
        document.execCommand('insertText', false, text);
      });
      box.addEventListener('drop', function (event) { event.preventDefault(); });
      Array.prototype.forEach.call(tools.querySelectorAll('[data-tprm-email-cmd]'), function (btn) {
        btn.addEventListener('mousedown', function (event) { event.preventDefault(); });
        btn.addEventListener('click', function () {
          restore(box);
          var cmd = btn.getAttribute('data-tprm-email-cmd');
          if (cmd === 'bold' || cmd === 'italic') document.execCommand(cmd, false, null);
          else if (cmd === 'list') document.execCommand('insertUnorderedList', false, null);
          else if (cmd === 'link') {
            var url = window.prompt('Link address. It must start with https:// or mailto:', 'https://');
            if (url == null) return;
            url = url.trim();
            if (/^[^\s@:/]+@[^\s@]+\.[^\s@]+$/.test(url)) url = 'mailto:' + url;
            if (!SAFE.test(url)) { window.alert('Use an address that starts with https:// or mailto:'); return; }
            restore(box);
            var sel = window.getSelection();
            if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) document.execCommand('createLink', false, url);
            else document.execCommand('insertHTML', false, '<a href="' + url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '">' + url.replace(/^mailto:/i, '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</a>&nbsp;');
          }
          sync();
          remember(box);
        });
      });
      var pick = tools.querySelector('[data-tprm-email-field]');
      if (pick) pick.addEventListener('change', function () {
        var key = pick.value;
        pick.value = '';
        if (!key) return;
        restore(box);
        document.execCommand('insertText', false, '{' + key + '}');
        sync();
        remember(box);
      });
    });
    ['subject', 'headline'].forEach(function (name) { if (form.elements[name]) form.elements[name].addEventListener('input', later); });
    form.addEventListener('submit', function () {
      Array.prototype.forEach.call(form.querySelectorAll('[data-tprm-email-region]'), function (region) {
        var box = region.querySelector('[data-tprm-email-rich]');
        var src = region.querySelector('[data-tprm-email-src]');
        if (box && src && !box.hidden) src.value = toMarkup(box);
      });
    });
    preview();
  }

  (function () {
    if (!window.fetch || !window.DOMParser || !window.URLSearchParams) return;
    function swap(oldEl, newEl) { if (oldEl && newEl) oldEl.replaceWith(document.importNode(newEl, true)); }
    function refresh(answerId, box, message) {
      var url = new URL(location.href);
      url.hash = '';
      if (answerId) url.searchParams.set('answers', 'all');
      return fetch(url.toString(), { credentials: 'same-origin', headers: { accept: 'text/html' } })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then(function (html) {
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var sid = box && box.getAttribute('data-tprm-ai-suggestion');
          if (sid) swap(box, doc.querySelector('[data-tprm-ai-suggestion="' + sid + '"]'));
          swap(document.querySelector('[data-tprm-ai-summary]'), doc.querySelector('[data-tprm-ai-summary]'));
          Array.prototype.forEach.call(document.querySelectorAll('[data-tprm-answer-filters] .tpa-filter'), function (el) {
            var f = el.getAttribute('data-tprm-answer-filter') || el.getAttribute('data-tprm-answer-filter-current');
            var twin = doc.querySelector('[data-tprm-answer-filter="' + f + '"] .tpa-filter-n, [data-tprm-answer-filter-current="' + f + '"] .tpa-filter-n');
            var mine = el.querySelector('.tpa-filter-n');
            if (twin && mine) mine.textContent = twin.textContent;
          });
          if (!answerId) return;
          var item = document.querySelector('[data-tprm-answer-item][data-tprm-answer-id="' + answerId + '"]');
          var newItem = doc.querySelector('[data-tprm-answer-item][data-tprm-answer-id="' + answerId + '"]');
          if (item && newItem) { var on = item.classList.contains('is-current'); item.innerHTML = newItem.innerHTML; item.classList.toggle('is-current', on); }
          var pane = document.querySelector('[data-tprm-answer-pane="' + answerId + '"]');
          var newPane = doc.querySelector('[data-tprm-answer-pane="' + answerId + '"]');
          if (!pane || !newPane) return;
          pane.setAttribute('data-tprm-answer-conclusion', newPane.getAttribute('data-tprm-answer-conclusion') || '');
          var form = pane.querySelector('[data-tprm-conclusion-form]');
          var newForm = newPane.querySelector('[data-tprm-conclusion-form]');
          if (form && newForm) {
            var rv = form.querySelector('input[name="row_version"]'), nrv = newForm.querySelector('input[name="row_version"]');
            if (rv && nrv) rv.value = nrv.value;
            var picked = newForm.querySelector('input[name="conclusion"]:checked');
            Array.prototype.forEach.call(form.querySelectorAll('input[name="conclusion"]'), function (r) { r.checked = !!picked && r.value === picked.value; });
            var st = form.querySelector('[data-tprm-save-state]'), nst = newForm.querySelector('[data-tprm-save-state]');
            if (st && nst) st.textContent = nst.textContent;
          }
          var reasons = pane.querySelector('[data-tprm-answer-reasons]');
          var newReasons = newPane.querySelector('[data-tprm-answer-reasons]');
          if (reasons && !newReasons) reasons.remove(); else swap(reasons, newReasons);
          var fresh = sid ? document.querySelector('[data-tprm-ai-suggestion="' + sid + '"] [data-tprm-ai-decided]') : null;
          if (fresh && message) fresh.setAttribute('title', message);
        });
    }
    document.addEventListener('submit', function (event) {
      var form = event.target;
      if (!form || !form.matches || !form.matches('form[data-tprm-ai-inplace]') || event.defaultPrevented) return;
      event.preventDefault();
      var box = form.closest('[data-tprm-ai-suggestion]');
      var state = box && box.querySelector('[data-tprm-ai-state]');
      var body = new URLSearchParams(new FormData(form));
      var buttons = box ? box.querySelectorAll('button, input[name="reason"]') : [];
      var answerInput = form.querySelector('input[name="answer_id"]');
      var answerId = answerInput ? answerInput.value : '';
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
      if (state) state.textContent = 'Saving...';
      var token = body.get('_csrf') || ((document.querySelector('meta[name="csrf-token"]') || {}).content || '');
      fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': token }, body: body.toString() })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok && d.ok !== false, d: d }; }); })
        .then(function (res) {
          if (!res.ok) {
            Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
            if (state) state.textContent = (res.d && res.d.message) || 'This could not be saved. Reload the page and try again.';
            return null;
          }
          return refresh(answerId, box, res.d && res.d.message).catch(function () { location.reload(); });
        })
        .catch(function () {
          Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
          if (state) state.textContent = 'The server did not answer. Nothing was changed: try again.';
        });
    });
  })();

  function initQuestionEditor() {
    var form = document.querySelector('form[data-tprm-q-editor]');
    if (!form || form.dataset.tpQEditorOn === '1') return;
    form.dataset.tpQEditorOn = '1';
    function sync() {
      var picked = form.querySelector('input[name="answer_type"]:checked') || form.querySelector('input[type="hidden"][name="answer_type"]');
      var t = picked ? picked.value : 'yes_no_na';
      Array.prototype.forEach.call(form.querySelectorAll('[data-tprm-q-for]'), function (el) {
        el.hidden = String(el.getAttribute('data-tprm-q-for')).split(' ').indexOf(t) < 0;
      });
      var ask = form.querySelector('input[name="ask_file"]');
      var sub = form.querySelector('[data-tprm-q-file]');
      if (sub) sub.hidden = !(t === 'file' || (ask && ask.checked && !ask.closest('[hidden]')));
      var when = form.querySelector('input[name="show_mode"][value="when"]');
      Array.prototype.forEach.call(form.querySelectorAll('[data-tprm-q-condition], select[name="show_join"]'), function (el) { el.hidden = !(when && when.checked); });
    }
    form.addEventListener('change', sync);
    var add = form.querySelector('[data-tprm-q-add-option]');
    var list = form.querySelector('[data-tprm-q-option-list]');
    function wireRemove(row) {
      var btn = row.querySelector('[data-tprm-q-remove-option]');
      if (!btn) return;
      btn.hidden = false;
      btn.addEventListener('click', function () {
        if (list.querySelectorAll('[data-tprm-q-option]').length <= 1) { row.querySelector('input').value = ''; return; }
        row.remove();
        form.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    if (list) Array.prototype.forEach.call(list.querySelectorAll('[data-tprm-q-option]'), wireRemove);
    var help = form.querySelector('[data-tprm-q-option-help]');
    if (help && list) help.textContent = 'An option a show-when rule uses cannot be removed until the rule changes.';
    if (add && list) {
      add.hidden = false;
      add.addEventListener('click', function () {
        var first = list.querySelector('[data-tprm-q-option]');
        var row = first.cloneNode(true);
        var input = row.querySelector('input');
        input.value = '';
        input.setAttribute('aria-label', 'Option ' + (list.querySelectorAll('[data-tprm-q-option]').length + 1));
        list.appendChild(row);
        wireRemove(row);
        input.focus();
      });
    }
    sync();
  }
  function initBuilder() {
    var root = document.querySelector('[data-tprm-q-builder][data-tprm-q-base]');
    if (!root || root.dataset.tpBuilderOn === '1') return;
    root.dataset.tpBuilderOn = '1';
    var base = root.getAttribute('data-tprm-q-base');
    var current = root.getAttribute('data-tprm-q-current') || '';
    var token = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
    var bulk = document.querySelector('[data-tprm-q-bulk]');
    var ticks = Array.prototype.slice.call(document.querySelectorAll('[data-tprm-q-tick]'));
    var all = document.querySelector('[data-tprm-q-tick-all]');
    var count = document.querySelector('[data-tprm-q-tick-count]');
    var hint = document.querySelector('[data-tprm-q-drag-hint]');
    if (hint) hint.hidden = false;

    function go(message, kind) {
      var url = base + '?s=' + encodeURIComponent(current) + '&toast=' + encodeURIComponent(message) + (kind ? '&toastKind=' + kind : '');
      window.location.assign(url);
    }
    function send(path, params) {
      return fetch(base + path, { method: 'POST', credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': token }, body: params.toString() })
        .then(function (r) { return r.json(); })
        .catch(function () { return { ok: false, message: 'That did not save. Reload the page and try again.' }; })
        .then(function (out) { go(out.message || 'Done', out.ok ? '' : 'error'); });
    }

    function syncTicks() {
      var n = ticks.filter(function (t) { return t.checked; }).length;
      if (count) count.textContent = n ? n + ' ticked' : 'Tick all';
      if (all) { all.checked = n > 0 && n === ticks.length; all.indeterminate = n > 0 && n < ticks.length; }
      if (bulk) Array.prototype.forEach.call(bulk.querySelectorAll('button[name="bulk"]'), function (b) { b.disabled = !n; });
    }
    ticks.forEach(function (t) { t.addEventListener('change', syncTicks); });
    if (all) all.addEventListener('change', function () { ticks.forEach(function (t) { t.checked = all.checked; }); syncTicks(); });
    syncTicks();
    if (bulk) {
      window.addEventListener('submit', function (event) {
        if (event.target !== bulk) return;
        Array.prototype.forEach.call(bulk.querySelectorAll('[data-tprm-q-bulk-confirm]'), function (el) { el.remove(); });
        if (!event.submitter || event.submitter.value !== 'remove' || bulk.dataset.tpConfirmed === '1') return;
        var n = ticks.filter(function (t) { return t.checked; }).length;
        [['_tp_confirm_title', 'Remove ' + n + ' question' + (n === 1 ? '' : 's') + '?'],
          ['_tp_confirm_body', 'They leave the draft. Their numbers are not handed out again, and questionnaires already sent keep them.'],
          ['_tp_confirm_action', 'Remove'], ['_tp_confirm_tone', 'problem']].forEach(function (pair) {
          var input = document.createElement('input');
          input.type = 'hidden'; input.name = pair[0]; input.value = pair[1];
          input.setAttribute('data-tprm-q-bulk-confirm', '');
          bulk.appendChild(input);
        });
      }, true);
    }

    var rows = Array.prototype.slice.call(root.querySelectorAll('[data-tprm-q-question]'));
    var links = Array.prototype.slice.call(root.querySelectorAll('[data-tprm-q-section]'));
    var dragQ = null;
    var dragS = null;
    var start = null;
    var handled = false;
    var idsOf = function () { return Array.prototype.map.call(root.querySelectorAll('[data-tprm-q-question]'), function (r) { return r.getAttribute('data-tprm-q-question'); }); };
    var keysOf = function () { return Array.prototype.map.call(root.querySelectorAll('[data-tprm-q-section]'), function (a) { return a.getAttribute('data-tprm-q-section'); }); };
    var place = function (moving, over, event) {
      var box = over.getBoundingClientRect();
      over.parentNode.insertBefore(moving, event.clientY > box.top + box.height / 2 ? over.nextSibling : over);
    };

    rows.forEach(function (row) {
      var grip = document.createElement('span');
      grip.className = 'qb-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.title = 'Drag to move';
      var code = row.querySelector('.qb-code');
      if (code) code.insertBefore(grip, code.firstChild);
      grip.addEventListener('mousedown', function () { row.draggable = true; });
      grip.addEventListener('mouseup', function () { row.draggable = false; });
      row.addEventListener('dragstart', function (event) {
        if (!row.draggable) return;
        dragQ = row; start = idsOf().join(); handled = false;
        row.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', row.getAttribute('data-tprm-q-question'));
      });
      var over = function (event) {
        if (!dragQ || dragQ === row || dragQ.parentNode !== row.parentNode) return;
        event.preventDefault();
        place(dragQ, row, event);
      };
      row.addEventListener('dragenter', over);
      row.addEventListener('dragover', over);
      row.addEventListener('drop', function (event) { if (dragQ) event.preventDefault(); });
      row.addEventListener('dragend', function () {
        row.draggable = false;
        row.classList.remove('is-dragging');
        var moved = dragQ;
        dragQ = null;
        if (!moved || handled || idsOf().join() === start) return;
        var p = new URLSearchParams();
        p.append('section', current);
        idsOf().forEach(function (id) { p.append('order', id); });
        send('/questions/order', p);
      });
    });

    links.forEach(function (link) {
      var key = link.getAttribute('data-tprm-q-section');
      link.addEventListener('dragstart', function (event) {
        dragS = link; start = keysOf().join();
        link.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', key);
      });
      var over = function (event) {
        if (dragS && dragS !== link) { event.preventDefault(); place(dragS, link, event); return; }
        if (dragQ && key !== current) { event.preventDefault(); link.classList.add('is-drop'); }
      };
      link.addEventListener('dragenter', over);
      link.addEventListener('dragover', over);
      link.addEventListener('dragleave', function () { link.classList.remove('is-drop'); });
      link.addEventListener('drop', function (event) {
        event.preventDefault();
        link.classList.remove('is-drop');
        if (!dragQ || key === current) return;
        handled = true;
        var p = new URLSearchParams();
        p.append('bulk', 'move');
        p.append('ids', dragQ.getAttribute('data-tprm-q-question'));
        p.append('to_section', key);
        p.append('s', current);
        send('/questions/bulk', p);
      });
      link.addEventListener('dragend', function () {
        link.classList.remove('is-dragging');
        var moved = dragS;
        dragS = null;
        if (!moved || keysOf().join() === start) return;
        var p = new URLSearchParams();
        keysOf().forEach(function (k) { p.append('order', k); });
        send('/sections/order', p);
      });
    });
  }

  function initPage() {
    if (restore()) return;
    window.appPageToast = null;
    Array.prototype.forEach.call(document.querySelectorAll('[data-tp-list]'), initList);
    Array.prototype.forEach.call(document.querySelectorAll('[data-tp-file]'), initFile);
    initBench(document.querySelector('[data-tprm-workbench]'));
    initUnsaved();
    initEmailEditor();
    initQuestionEditor();
    initBuilder();
  }
  initPage();
  document.addEventListener('app:page-swapped', initPage);
})();
