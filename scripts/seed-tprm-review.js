'use strict';

const bcrypt = require('bcrypt');
const { createDatabase } = require('../lib/pg');

const REVIEW_USERS = Object.freeze({
  senior: Object.freeze({
    email: 'tprm-senior@review.local',
    name: 'Riya Senior (TPRM review)',
    password: 'TprmReview-Senior-2026',
    firmRole: 'senior_consultant',
  }),
  consultant: Object.freeze({
    email: 'tprm-consultant@review.local',
    name: 'Kabir Consultant (TPRM review)',
    password: 'TprmReview-Consultant-2026',
    firmRole: 'consultant',
  }),
  client: Object.freeze({
    email: 'tprm-client@review.local',
    name: 'Arjun Client (TPRM review)',
    password: 'TprmReview-Client-2026',
    memberRole: 'client_owner',
  }),
});

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: DATABASE_URL=postgres://... node scripts/seed-tprm-review.js <workspaceId> [--enable-tprm]');
  process.exit(2);
}

async function upsertUser(db, { email, name, password, userType, firmId, firmRole }) {
  const existing = await db.prepare('SELECT id, user_type, firm_id FROM users WHERE lower(email)=lower(?)').get(email);
  const hash = bcrypt.hashSync(password, 12);
  if (existing) {
    if (existing.user_type !== userType) throw new Error(`${email} already exists as a ${existing.user_type} user; refusing to change its type.`);
    if (userType === 'firm' && Number(existing.firm_id) !== Number(firmId)) {
      throw new Error(`${email} already belongs to firm ${existing.firm_id}; refusing to move it to firm ${firmId}.`);
    }
    await db.prepare(`UPDATE users SET name=?, password_hash=?, active=1, firm_role=?,
      mfa_secret=NULL, mfa_enabled_at=NULL, mfa_recovery_codes=NULL, auth_epoch=auth_epoch+1 WHERE id=?`)
      .run(name, hash, firmRole || null, existing.id);
    return { id: existing.id, created: false };
  }
  const info = await db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)`).run(email, hash, name, userType, userType === 'firm' ? firmId : null, firmRole || null);
  return { id: Number(info.lastInsertRowid), created: true };
}

async function addMember(db, workspaceId, userId, role) {
  await db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role=EXCLUDED.role`).run(workspaceId, userId, role);
}

async function main() {
  const args = process.argv.slice(2);
  const enableTprm = args.includes('--enable-tprm');
  const positional = args.filter(a => !a.startsWith('--'));
  if (positional.length !== 1 || !/^\d+$/.test(positional[0])) usage('A single numeric workspace id is required.');
  if (!process.env.DATABASE_URL) usage('DATABASE_URL is not set.');
  if (process.env.NODE_ENV === 'production') usage('Refusing to run with NODE_ENV=production: this script is for local review only.');
  const workspaceId = Number(positional[0]);

  const db = createDatabase(process.env.DATABASE_URL, { max: 2, applicationName: 'iso27001-tool:seed-tprm-review' });
  try {
    await db.loadCatalog();
    const ws = await db.prepare('SELECT id, firm_id, client_name FROM workspaces WHERE id=?').get(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} does not exist.`);
    const hasTprmSchema = await db.prepare("SELECT to_regclass('tp_client_settings') AS reg").get();
    if (enableTprm && !hasTprmSchema.reg) throw new Error('tp_client_settings does not exist yet: boot the app once so migration 090 applies.');

    const result = await db.transaction(async () => {
      const senior = await upsertUser(db, { ...REVIEW_USERS.senior, userType: 'firm', firmId: ws.firm_id });
      await addMember(db, ws.id, senior.id, REVIEW_USERS.senior.firmRole);
      const consultant = await upsertUser(db, { ...REVIEW_USERS.consultant, userType: 'firm', firmId: ws.firm_id });
      await addMember(db, ws.id, consultant.id, REVIEW_USERS.consultant.firmRole);
      const clientUser = await upsertUser(db, { ...REVIEW_USERS.client, userType: 'client' });
      await addMember(db, ws.id, clientUser.id, REVIEW_USERS.client.memberRole);
      if (enableTprm) {
        await db.prepare(`INSERT INTO tp_client_settings (workspace_id, enabled, enabled_at, enabled_by)
          VALUES (?, true, now(), ?)
          ON CONFLICT (workspace_id) DO UPDATE SET enabled=true,
            enabled_at=COALESCE(tp_client_settings.enabled_at, now()),
            updated_at=now(),
            row_version=tp_client_settings.row_version + CASE WHEN tp_client_settings.enabled THEN 0 ELSE 1 END`)
          .run(ws.id, senior.id);
      }
      return { senior, consultant, clientUser };
    })();

    const tprmOn = hasTprmSchema.reg
      ? !!(await db.prepare('SELECT enabled FROM tp_client_settings WHERE workspace_id=?').get(ws.id) || {}).enabled
      : false;
    console.log(`TPRM review logins for workspace ${ws.id} (${ws.client_name}), firm ${ws.firm_id}:`);
    console.log(`  Senior consultant  ${REVIEW_USERS.senior.email}  /  ${REVIEW_USERS.senior.password}  (${result.senior.created ? 'created' : 'reset'})`);
    console.log(`  Consultant         ${REVIEW_USERS.consultant.email}  /  ${REVIEW_USERS.consultant.password}  (${result.consultant.created ? 'created' : 'reset'}; proposes and drafts, the senior confirms and issues)`);
    console.log(`  Client sponsor     ${REVIEW_USERS.client.email}  /  ${REVIEW_USERS.client.password}  (${result.clientUser.created ? 'created' : 'reset'}; can be the client decision owner)`);
    console.log(`  Third-party risk for this client: ${tprmOn ? 'on' : 'off (switch it on from /tprm, or re-run with --enable-tprm)'}`);
  } finally {
    await db.close();
  }
}

module.exports = { REVIEW_USERS };

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}
