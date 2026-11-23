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
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) shown.textContent = 'Uploading, ' + Math.round((e.loaded / e.total) * 100) + '%';
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
})();
