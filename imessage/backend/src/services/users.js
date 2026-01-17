import { query } from '../db.js';

export async function searchUsers(searchTerm, currentUserId, limit = 20) {
  const result = await query(
    `SELECT id, username, display_name, avatar_url
     FROM users
     WHERE id != $1
       AND (username ILIKE $2 OR display_name ILIKE $2 OR email ILIKE $2)
     LIMIT $3`,
    [currentUserId, `%${searchTerm}%`, limit]
  );

  return result.rows;
}

export async function getUserById(userId) {
  const result = await query(
    `SELECT id, username, email, display_name, avatar_url, status, last_seen, created_at
     FROM users WHERE id = $1`,
    [userId]
  );

  return result.rows[0] || null;
}

export async function updateUser(userId, updates) {
  const allowedFields = ['display_name', 'avatar_url'];
  const setClauses = [];
  const values = [userId];
  let paramIndex = 2;

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    throw new Error('No valid fields to update');
  }

  const result = await query(
    `UPDATE users SET ${setClauses.join(', ')}, updated_at = NOW()
     WHERE id = $1
     RETURNING id, username, email, display_name, avatar_url`,
    values
  );

  return result.rows[0];
}

export async function updateUserStatus(userId, status) {
  await query(
    `UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2`,
    [status, userId]
  );
}
