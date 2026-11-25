'use strict';

const audit = require('../lib/file-store-audit');
const store = require('../lib/file-store');

function usage() {
  console.error('Usage: DATABASE_URL=postgres://... node scripts/file-store.js check');
  console.error('       DATABASE_URL=postgres://... ISMS_S3_BUCKET=<bucket> node scripts/file-store.js copy');
  console.error('check  lists every stored file the database refers to, and the ones found neither on this server nor in the bucket.');
  console.error('copy   copies the files in uploads/ to the bucket, each into its client\'s folder when the database says which client it belongs to; files already there are left alone.');
  process.exit(2);
}

async function main() {
  const command = process.argv[2];
  if (command !== 'check' && command !== 'copy') usage();
  const { db } = require('../db');
  try {
    if (command === 'copy') {
      const r = await audit.copyLocal(db);
      console.log(`Files in uploads/: ${r.seen}. Copied to the bucket: ${r.copied} (${r.underClient} into a client folder). Already there: ${r.alreadyThere}. Skipped (not a stored upload): ${r.skipped}.`);
      return;
    }
    const r = await audit.check(db);
    console.log(`Stored files the database refers to: ${r.total}. On this server: ${r.onThisServer}. In the bucket: ${store.enabled() ? r.inBucket : 'no bucket set'}. Missing: ${r.missing.length}.`);
    for (const m of r.missing) console.log(`  missing  ${m.table}.${m.column} id ${m.id}  firm ${m.firmId}  ${m.stored}`);
  } finally {
    await db.close();
  }
}

main().catch(err => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
