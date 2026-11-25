(function () {
  'use strict';

  function sizeText(n) {
    if (n < 1024) return n + ' bytes';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function noteFor(input) {
    var note = document.createElement('p');
    note.className = 'vq-file-note';
    note.setAttribute('aria-live', 'polite');
    input.insertAdjacentElement('afterend', note);
    return note;
  }

  function describe(input, note) {
    var files = Array.prototype.slice.call(input.files || []);
    note.textContent = files.map(function (f) { return f.name + ', ' + sizeText(f.size); }).join('; ');
  }

  var notes = new Map();
  Array.prototype.forEach.call(document.querySelectorAll('input.vq-file-input[type="file"]'), function (input) {
    var note = noteFor(input);
    notes.set(input, note);
    input.addEventListener('change', function () { describe(input, note); });
  });

  var watched = new Set();
  notes.forEach(function (note, input) {
    var form = input.form;
    if (!form || watched.has(form) || typeof FormData === 'undefined') return;
    watched.add(form);
    form.addEventListener('submit', function (event) {
      var inputs = Array.prototype.filter.call(form.elements, function (el) { return el.type === 'file' && el.files && el.files.length; });
      if (event.defaultPrevented || !inputs.length) return;
      event.preventDefault();
      var data = new FormData(form);
      if (event.submitter && event.submitter.name) data.append(event.submitter.name, event.submitter.value);
      var shown = notes.get(inputs[0]);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', form.action);
      xhr.timeout = 150000;
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable && e.loaded < e.total) shown.textContent = 'Uploading, ' + Math.round((e.loaded / e.total) * 100) + '%';
      });
      xhr.upload.addEventListener('load', function () {
        shown.textContent = 'Uploaded. Checking the file, this can take a moment.';
      });
      xhr.addEventListener('timeout', function () {
        shown.textContent = 'The server did not answer in time. Reload the page to see whether the file was saved, then try again if it was not.';
      });
      xhr.addEventListener('load', function () {
        var posted = new URL(form.action, location.href).href.split('#')[0];
        if (xhr.status < 400 && xhr.responseURL && xhr.responseURL.split('#')[0] !== posted) { location.assign(xhr.responseURL); return; }
        document.open(); document.write(xhr.responseText); document.close();
      });
      xhr.addEventListener('error', function () {
        shown.textContent = 'The upload did not reach the server. Nothing was saved: check the connection and try again.';
      });
      shown.textContent = 'Uploading, 0%';
      xhr.send(data);
    });
  });

  function domAnswer(qid) {
    var picked = Array.prototype.filter.call(document.querySelectorAll('input[name="r[' + qid + ']"]'), function (r) { return r.checked; })[0];
    if (picked) return { response: picked.value, fields: null };
    var vals = Array.prototype.filter.call(document.querySelectorAll('[name="f[' + qid + '][value]"], [name="f[' + qid + '][value][]"]'), function (el) {
      return el.type === 'radio' || el.type === 'checkbox' ? el.checked : true;
    }).map(function (el) { return String(el.value || '').trim(); }).filter(Boolean);
    return vals.length ? { response: 'value', fields: { value: vals.join('; ') } } : null;
  }
  function conditionMet(c, a) {
    var answered = !!(a && a.response);
    if (c.op === 'answered') return answered;
    if (c.op === 'not_answered') return !answered;
    if (!answered) return false;
    var value = a.response === 'value' ? String((a.fields || {}).value || '') : String(a.response);
    var list = value.split(/;\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
    var want = String(c.value || '').trim();
    if (c.op === 'is') return value === want || (list.length > 1 && list.indexOf(want) >= 0);
    if (c.op === 'is_not') return !(value === want || list.indexOf(want) >= 0);
    if (c.op === 'includes') return list.indexOf(want) >= 0;
    var n = Number(value.replace(',', '.')), m = Number(want.replace(',', '.'));
    if (isNaN(n) || isNaN(m)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value) && /^\d{4}-\d{2}-\d{2}$/.test(want)) return c.op === 'more_than' ? value > want : value < want;
      return false;
    }
    return c.op === 'more_than' ? n > m : n < m;
  }
  var ruleBoxes = Array.prototype.filter.call(document.querySelectorAll('[data-vendor-followup-rule]'), function (box) {
    try { box._rule = JSON.parse(box.getAttribute('data-vendor-followup-rule')); } catch (_) { return false; }
    return !!box._rule && box._rule.conditions.every(function (c) { return !!document.querySelector('[data-vendor-question="' + c.question + '"]'); });
  });
  function syncRules() {
    ruleBoxes.forEach(function (box) {
      var results = box._rule.conditions.map(function (c) { return conditionMet(c, domAnswer(c.question)); });
      var parentBox = document.querySelector('[data-vendor-question="' + box.getAttribute('data-vendor-followup-of') + '"]');
      box.hidden = !!(parentBox && parentBox.hidden) || !(box._rule.mode === 'any' ? results.some(Boolean) : results.every(Boolean));
    });
  }
  if (ruleBoxes.length) {
    document.addEventListener('change', syncRules);
    document.addEventListener('input', syncRules);
    syncRules();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-vendor-followup-of][data-vendor-followup-when]'), function (box) {
    var parent = box.getAttribute('data-vendor-followup-of');
    var when = box.getAttribute('data-vendor-followup-when');
    var radios = document.querySelectorAll('input[name="r[' + parent + ']"]');
    function sync() {
      var picked = Array.prototype.filter.call(radios, function (r) { return r.checked; })[0];
      box.hidden = !(picked && picked.value === when);
    }
    Array.prototype.forEach.call(radios, function (r) { r.addEventListener('change', sync); });
    if (radios.length) sync();
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-vendor-jump]'), function (box) {
    var select = box.querySelector('select');
    var go = box.querySelector('[data-vendor-jump-go]');
    if (!select || !go) return;
    box.classList.add('js-jump');
    select.addEventListener('change', function () { go.click(); });
  });
})();
