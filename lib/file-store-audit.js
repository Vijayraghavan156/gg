'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./file-store');

const TABLES = Object.freeze(['evidence', 'generated_docs', 'auditor_shares', 'tp_evidence', 'tp_condition_proof_files']);
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

async function storedFiles(db) {
  const cols = await db.prepare(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name LIKE '%stored_path' AND table_name IN (${TABLES.map(() => '?').join(',')})
    ORDER BY table_name, column_name`).all(...TABLES);
  const rows = [];
  for (const { table_name: table, column_name: column } of cols) {
    if (!TABLES.includes(table) || !IDENT.test(column)) continue;
    const found = await db.prepare(`SELECT t.id, t.${column} AS stored, w.firm_id, t.workspace_id FROM ${table} t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.${column} IS NOT NULL AND t.${column} <> '' ORDER BY t.id`).all();
    for (const r of found) {
      rows.push({ table, column, id: Number(r.id), stored: String(r.stored), firmId: Number(r.firm_id) || 0, workspaceId: Number(r.workspace_id) || 0 });
    }
  }
  return rows;
}

async function check(db) {
  const rows = await storedFiles(db);
  const out = { total: rows.length, onThisServer: 0, inBucket: 0, missing: [] };
  for (const r of rows) {
    const places = store.candidates(r.stored, r.firmId, r.workspaceId);
    if (places.some(p => fs.existsSync(p))) { out.onThisServer += 1; continue; }
    let remote = false;
    if (store.enabled()) for (const p of places) if (await store.exists(p)) { remote = true; break; }
    if (remote) out.inBucket += 1;
    else out.missing.push(r);
  }
  return out;
}

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => path.join(dir, e.name));
}

function localFiles() {
  const out = [];
  if (!fs.existsSync(store.ROOT)) return out;
  out.push(...filesIn(store.ROOT));
  for (const firm of fs.readdirSync(store.ROOT, { withFileTypes: true })) {
    if (!firm.isDirectory() || !/^firm_\d+$/.test(firm.name)) continue;
    const firmDir = path.join(store.ROOT, firm.name);
    out.push(...filesIn(firmDir));
    for (const client of fs.readdirSync(firmDir, { withFileTypes: true })) {
      if (client.isDirectory() && /^client_\d+$/.test(client.name)) out.push(...filesIn(path.join(firmDir, client.name)));
    }
  }
  return out;
}

async function ownersByFile(db) {
  const owners = new Map();
  for (const r of await storedFiles(db)) {
    if (!r.firmId || !r.workspaceId || path.basename(r.stored) !== r.stored) continue;
    const key = `${r.firmId}/${r.stored}`;
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(r.workspaceId);
  }
  return owners;
}

function placeFor(file, owners) {
  const parts = path.relative(store.ROOT, file).split(path.sep);
  const firm = parts.length === 2 ? /^firm_(\d+)$/.exec(parts[0]) : null;
  if (!firm) return file;
  const clients = owners.get(`${Number(firm[1])}/${parts[1]}`);
  if (!clients || clients.size !== 1) return file;
  return path.join(store.dirFor(Number(firm[1]), [...clients][0]), parts[1]);
}

async function copyLocal(db) {
  if (!store.enabled()) throw new Error('Set ISMS_S3_BUCKET first: there is no bucket to copy the files to.');
  const out = { seen: 0, copied: 0, underClient: 0, alreadyThere: 0, skipped: 0 };
  keyCache = null;
  const owners = db ? await ownersByFile(db) : new Map();
  for (const file of localFiles()) {
    out.seen += 1;
    const target = placeFor(file, owners);
    if (!store.keyFor(target)) { out.skipped += 1; continue; }
    if (await remoteHas(target)) { out.alreadyThere += 1; continue; }
    await store.put(file, target);
    out.copied += 1;
    if (path.basename(path.dirname(target)).startsWith('client_')) out.underClient += 1;
  }
  return out;
}

async function remoteHas(file) {
  const key = store.keyFor(file);
  if (!key) return false;
  const keys = await cachedKeys();
  return keys.has(key);
}

let keyCache = null;
async function cachedKeys() {
  if (!keyCache) keyCache = new Set(await store.listKeys());
  return keyCache;
}

module.exports = { TABLES, storedFiles, check, localFiles, copyLocal };
