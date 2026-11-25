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
    const found = await db.prepare(`SELECT t.id, t.${column} AS stored, w.firm_id FROM ${table} t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.${column} IS NOT NULL AND t.${column} <> '' ORDER BY t.id`).all();
    for (const r of found) rows.push({ table, column, id: Number(r.id), stored: String(r.stored), firmId: Number(r.firm_id) || 0 });
  }
  return rows;
}

async function check(db) {
  const rows = await storedFiles(db);
  const out = { total: rows.length, onThisServer: 0, inBucket: 0, missing: [] };
  for (const r of rows) {
    const places = store.candidates(r.stored, r.firmId);
    if (places.some(p => fs.existsSync(p))) { out.onThisServer += 1; continue; }
    let remote = false;
    if (store.enabled()) for (const p of places) if (await store.exists(p)) { remote = true; break; }
    if (remote) out.inBucket += 1;
    else out.missing.push(r);
  }
  return out;
}

function localFiles() {
  const out = [];
  if (!fs.existsSync(store.ROOT)) return out;
  for (const entry of fs.readdirSync(store.ROOT, { withFileTypes: true })) {
    const full = path.join(store.ROOT, entry.name);
    if (entry.isFile() && !entry.name.startsWith('.')) out.push(full);
    else if (entry.isDirectory() && /^firm_\d+$/.test(entry.name)) {
      for (const inner of fs.readdirSync(full, { withFileTypes: true })) {
        if (inner.isFile() && !inner.name.startsWith('.')) out.push(path.join(full, inner.name));
      }
    }
  }
  return out;
}

async function copyLocal() {
  if (!store.enabled()) throw new Error('Set ISMS_S3_BUCKET first: there is no bucket to copy the files to.');
  const out = { seen: 0, copied: 0, alreadyThere: 0, skipped: 0 };
  keyCache = null;
  for (const file of localFiles()) {
    out.seen += 1;
    if (!store.keyFor(file)) { out.skipped += 1; continue; }
    if (await remoteHas(file)) { out.alreadyThere += 1; continue; }
    await store.put(file);
    out.copied += 1;
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
