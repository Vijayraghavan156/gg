'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const uploadSecurity = require('../lib/upload-security');

test('upload validation checks content signatures rather than trusting names', () => {
  const previous = process.env.UPLOAD_AV_MODE;
  process.env.UPLOAD_AV_MODE = 'off';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-security-'));
  try {
    const fakePdf = path.join(dir, 'fake.pdf');
    fs.writeFileSync(fakePdf, '<script>alert(1)</script>');
    const rejected = uploadSecurity.validateUpload({ path: fakePdf, originalname: 'evidence.pdf', size: 25 }, new Set(['pdf']));
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /do not match/i);

    const realPdf = path.join(dir, 'real.pdf');
    fs.writeFileSync(realPdf, '%PDF-1.7\n% test document');
    assert.equal(uploadSecurity.validateUpload({ path: realPdf, originalname: 'evidence.pdf', size: 24 }, new Set(['pdf'])).ok, true);

    const executable = path.join(dir, 'payload.exe');
    fs.writeFileSync(executable, 'MZ');
    assert.equal(uploadSecurity.validateUpload({ path: executable, originalname: 'payload.exe', size: 2 }, new Set(['pdf'])).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.UPLOAD_AV_MODE;
    else process.env.UPLOAD_AV_MODE = previous;
  }
});

test('memory-backed uploads receive the same signature inspection', () => {
  const previous = process.env.UPLOAD_AV_MODE;
  process.env.UPLOAD_AV_MODE = 'off';
  try {
    const csv = Buffer.from('owner,status\nPriya,approved\n', 'utf8');
    assert.equal(uploadSecurity.validateUpload({
      buffer: csv, originalname: 'evidence.csv', size: csv.length
    }, new Set(['csv'])).ok, true);

    const disguisedBinary = Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02]);
    const rejected = uploadSecurity.validateUpload({
      buffer: disguisedBinary, originalname: 'evidence.csv', size: disguisedBinary.length
    }, new Set(['csv']));
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /do not match/i);
  } finally {
    if (previous === undefined) delete process.env.UPLOAD_AV_MODE;
    else process.env.UPLOAD_AV_MODE = previous;
  }
});

test('with the clamd client, readiness pings the daemon and scans pass the open file', () => {
  const saved = { mode: process.env.UPLOAD_AV_MODE, bin: process.env.CLAMAV_BIN };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-security-clamd-'));
  try {
    const calls = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'clamdscan');
    fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${calls}'\ncase "$*" in *infected*) exit 1 ;; esac\nexit 0\n`, { mode: 0o755 });
    process.env.CLAMAV_BIN = bin;
    process.env.UPLOAD_AV_MODE = 'required';
    assert.equal(uploadSecurity.scannerAvailable(), true);

    const clean = path.join(dir, 'clean.pdf');
    fs.writeFileSync(clean, '%PDF-1.7\n% clean');
    assert.deepEqual(uploadSecurity.validateUpload({ path: clean, originalname: 'clean.pdf', size: 16 }, new Set(['pdf'])), { ok: true, scanner: 'clamav' });
    const infected = path.join(dir, 'infected.pdf');
    fs.writeFileSync(infected, '%PDF-1.7\n% infected');
    const rejected = uploadSecurity.validateUpload({ path: infected, originalname: 'infected.pdf', size: 19 }, new Set(['pdf']));
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /rejected by the malware scanner/);

    const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.equal(lines[0], '--ping 1');
    assert.equal(lines[1], `--no-summary --fdpass ${clean}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, name] of [['mode', 'UPLOAD_AV_MODE'], ['bin', 'CLAMAV_BIN']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
});

test('the container image starts clamd before the app and scans through it', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /CLAMAV_BIN=\/usr\/bin\/clamdscan/);
  assert.match(dockerfile, /'LocalSocket \/tmp\/clamd\.sock'/);
  assert.match(dockerfile, /^CMD \["\/bin\/sh", "-c", "clamd \|\| .*; exec node server\.js"\]$/m);
});
