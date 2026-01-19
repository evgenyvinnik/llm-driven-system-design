import { query } from '../db.js';

interface User {
  id: string;
  username: string;
  email?: string;
  display_name: string;
  avatar_url: string | null;
  status?: string;
  last_seen?: Date;
  created_at?: Date;
}

interface UserUpdates {
  display_name?: string;
  avatar_url?: string;
  [key: string]: string | undefined;
}

export async function searchUsers(
  searchTerm: string,
  currentUserId: string,
  limit: number = 20
): Promise<User[]> {
  const result = await query<User>(
    `SELECT id, username, display_name, avatar_url
     FROM users
     WHERE id != $1
       AND (username ILIKE $2 OR display_name ILIKE $2 OR email ILIKE $2)
     LIMIT $3`,
    [currentUserId, `%${searchTerm}%`, limit]
  );

  return result.rows;
}

export async function getUserById(userId: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT id, username, email, display_name, avatar_url, status, last_seen, created_at
     FROM users WHERE id = $1`,
    [userId]
  );

  return result.rows[0] || null;
}

export async function updateUser(userId: string, updates: UserUpdates): Promise<User> {
  const allowedFields = ['display_name', 'avatar_url'];
  const setClauses: string[] = [];
  const values: unknown[] = [userId];
  let paramIndex = 2;

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    throw new Error('No valid fields to update');
  }

  const result = await query<User>(
    `UPDATE users SET ${setClauses.join(', ')}, updated_at = NOW()
     WHERE id = $1
     RETURNING id, username, email, display_name, avatar_url`,
    values
  );

  return result.rows[0];
}

export async function updateUserStatus(userId: string, status: string): Promise<void> {
  await query(
    `UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2`,
    [status, userId]
  );
}
