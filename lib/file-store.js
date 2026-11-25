'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const ROOT = path.resolve(__dirname, '..', 'uploads');
let injected = null;
let client = null;

const bucket = () => String(process.env.ISMS_S3_BUCKET || '').trim();
const prefix = () => {
  const p = String(process.env.ISMS_S3_PREFIX || '').trim().replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
};
const enabled = () => !!bucket();

function s3() {
  if (injected) return injected;
  if (!client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    const region = process.env.ISMS_S3_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    client = new S3Client(region ? { region } : {});
  }
  return client;
}

function useClient(fake) {
  injected = fake || null;
}

function keyFor(absPath) {
  if (!absPath) return null;
  const rel = path.relative(ROOT, path.resolve(String(absPath)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.some(p => !p || p === '.' || p === '..')) return null;
  if (parts.length > 2 || (parts.length === 2 && !/^firm_\d+$/.test(parts[0]))) return null;
  return prefix() + parts.join('/');
}

function pathForKey(key) {
  const p = prefix();
  const rel = String(key || '');
  if (p && !rel.startsWith(p)) return null;
  const rest = rel.slice(p.length);
  const parts = rest.split('/');
  if (parts.some(x => !x || x === '.' || x === '..')) return null;
  if (parts.length > 2 || (parts.length === 2 && !/^firm_\d+$/.test(parts[0]))) return null;
  return path.join(ROOT, ...parts);
}

const missing = err => !!err && (err.name === 'NoSuchKey' || err.name === 'NotFound' || (err.$metadata && err.$metadata.httpStatusCode === 404));

async function command(name, input) {
  const sdk = injected ? null : require('@aws-sdk/client-s3');
  if (injected) return injected.send({ name, input });
  return s3().send(new sdk[name](input));
}

async function put(absPath) {
  if (!enabled()) return { stored: false };
  const key = keyFor(absPath);
  if (!key) throw new Error('A file outside the uploads folder cannot be stored.');
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) throw new Error('Only a regular file can be stored.');
  await command('PutObjectCommand', { Bucket: bucket(), Key: key, Body: fs.createReadStream(absPath), ContentLength: stat.size });
  return { stored: true, key };
}

async function putMany(paths) {
  const done = [];
  try {
    for (const p of paths) {
      const r = await put(p);
      if (r.stored) done.push(p);
    }
  } catch (err) {
    for (const p of done) await removeRemote(p).catch(() => {});
    throw err;
  }
  return done.length;
}

async function ensureLocal(absPath) {
  if (!absPath) return false;
  if (fs.existsSync(absPath)) return true;
  if (!enabled()) return false;
  const key = keyFor(absPath);
  if (!key) return false;
  let out;
  try {
    out = await command('GetObjectCommand', { Bucket: bucket(), Key: key });
  } catch (err) {
    if (missing(err)) return false;
    throw err;
  }
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.fetch-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await pipeline(out.Body, fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
    fs.renameSync(temporary, absPath);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw err;
  }
  return true;
}

async function removeRemote(absPath) {
  if (!enabled()) return false;
  const key = keyFor(absPath);
  if (!key) return false;
  await command('DeleteObjectCommand', { Bucket: bucket(), Key: key });
  return true;
}

async function remove(absPath) {
  if (!absPath) return;
  try { if (fs.existsSync(absPath)) fs.unlinkSync(absPath); } catch (_) {}
  await removeRemote(absPath);
}

function removeLater(absPath) {
  if (!absPath || !enabled()) return;
  removeRemote(absPath).catch(err => console.error('[file_store] could not delete a stored file:', err && err.name ? err.name : 'error'));
}

async function exists(absPath) {
  if (absPath && fs.existsSync(absPath)) return true;
  if (!enabled()) return false;
  const key = keyFor(absPath);
  if (!key) return false;
  try {
    await command('HeadObjectCommand', { Bucket: bucket(), Key: key });
    return true;
  } catch (err) {
    if (missing(err)) return false;
    throw err;
  }
}

async function listKeys(under = '') {
  const keys = [];
  let token;
  do {
    const out = await command('ListObjectsV2Command', { Bucket: bucket(), Prefix: (prefix() + under) || undefined, ContinuationToken: token });
    for (const o of out.Contents || []) keys.push(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function removeFirm(firmId) {
  if (!enabled() || !Number(firmId)) return 0;
  let n = 0;
  for (const key of await listKeys(`firm_${Number(firmId)}/`)) {
    await command('DeleteObjectCommand', { Bucket: bucket(), Key: key });
    n += 1;
  }
  return n;
}

function candidates(storedPath, firmId) {
  const name = String(storedPath || '');
  if (!name || path.basename(name) !== name) return [];
  const out = [];
  if (Number(firmId)) out.push(path.join(ROOT, `firm_${Number(firmId)}`, name));
  out.push(path.join(ROOT, name));
  return out;
}

async function removeStored(storedPath, firmId) {
  for (const p of candidates(storedPath, firmId)) await remove(p);
}

function keepStaged(req, res, files) {
  if (!enabled() || !files.length) return;
  let done = false;
  const sweep = () => {
    if (done) return;
    done = true;
    for (const f of files) if (f && f.path && !fs.existsSync(f.path)) removeLater(f.path);
  };
  res.once('finish', sweep);
  res.once('close', sweep);
}

module.exports = { ROOT, candidates, removeStored, removeFirm, enabled, keyFor, pathForKey, put, putMany, ensureLocal, remove, removeLater, exists, listKeys, keepStaged, useClient };
