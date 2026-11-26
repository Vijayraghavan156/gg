'use strict';

async function isWorkspacePerson(db, ws, userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const row = await db.prepare(`SELECT u.id FROM users u
    LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ?
    WHERE u.id = ? AND ((u.user_type = 'firm' AND u.firm_id = ? AND u.active = 1) OR m.workspace_id IS NOT NULL)`)
    .get(ws.id, id, ws.firm_id);
  return !!row;
}

function notOnClient(req, res) {
  return res.status(400).render('error', { user: req.user, ws: req.workspace, message: 'That person is not on this client. Choose someone from the list.' });
}

module.exports = { isWorkspacePerson, notOnClient };
