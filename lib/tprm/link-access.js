'use strict';

const sameEmail = (column, link) => `${column} = lower(trim(${link}.recipient_email))`;

const removedSql = (link, tp) => `EXISTS (SELECT 1 FROM tp_vendor_people gone
    WHERE gone.workspace_id = ${link}.workspace_id AND gone.third_party_id = ${tp} AND ${sameEmail('gone.email', link)}
      AND gone.status = 'removed' AND gone.removed_at >= ${link}.created_at)`;

const movedSql = (link, tp) => `EXISTS (SELECT 1 FROM tp_events moved
    WHERE moved.workspace_id = ${link}.workspace_id AND moved.third_party_id = ${tp} AND moved.action = 'vendor_person.changed'
      AND ${sameEmail("(moved.before_state->>'email')", link)} AND (moved.after_state->>'email') IS DISTINCT FROM (moved.before_state->>'email')
      AND moved.created_at >= ${link}.created_at)`;

const recipientLeft = (link, tp) => `((${removedSql(link, tp)}
  OR ${movedSql(link, tp)})
  AND NOT EXISTS (SELECT 1 FROM tp_vendor_people again
    WHERE again.workspace_id = ${link}.workspace_id AND again.third_party_id = ${tp} AND ${sameEmail('again.email', link)} AND again.status = 'active'))`;

const mainContactSql = (ws, tp, column) => `(SELECT m.${column} FROM tp_vendor_people m
    WHERE m.workspace_id = ${ws} AND m.third_party_id = ${tp} AND m.status = 'active' AND m.role = 'main' ORDER BY m.id LIMIT 1)`;

const TABLES = Object.freeze({ q: 'tp_vendor_requests', c: 'tp_condition_links' });

const closedColumns = (link, a, t) => `${recipientLeft(link, `${a}.third_party_id`)} AS recipient_left, ${removedSql(link, `${a}.third_party_id`)} AS recipient_removed, (${t}.status = 'exited') AS third_party_exited`;

function closedNote(row) {
  if (row.third_party_exited) return 'It no longer opens because the third party has exited.';
  if (row.recipient_left && row.recipient_removed === false) return 'It no longer opens because the email address it was sent to was changed.';
  if (row.recipient_left) return `It no longer opens because ${row.recipient_name || 'the person it was sent to'} is no longer one of the people at this third party.`;
  return null;
}

async function linkClosed(db, token, family = 'q') {
  const hash = require('./questionnaires').keyHash(token);
  if (!hash) return false;
  const row = await db.prepare(`SELECT ${closedColumns('l', 'a', 't')}
    FROM ${TABLES[family] || TABLES.q} l
    JOIN tp_assessments a ON a.workspace_id = l.workspace_id AND a.id = l.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    WHERE l.token_hash = ?`).get(hash);
  return !!row && (!!row.third_party_exited || !!row.recipient_left);
}

async function recipientGone(db, link) {
  if (!link || !link.id) return false;
  const row = await db.prepare(`SELECT ${recipientLeft('l', 'a.third_party_id')} AS recipient_left
    FROM tp_vendor_requests l
    JOIN tp_assessments a ON a.workspace_id = l.workspace_id AND a.id = l.assessment_id
    WHERE l.workspace_id = ? AND l.id = ?`).get(link.workspace_id, link.id);
  return !!(row && row.recipient_left);
}

module.exports = { recipientLeft, recipientRemoved: removedSql, mainContactSql, closedColumns, closedNote, linkClosed, recipientGone };
