import { query } from '../db/index.js';
import { User } from '../types/index.js';

export class UserService {
  async getUser(userId: string): Promise<User | null> {
    const rows = await query<User>('SELECT * FROM users WHERE id = $1', [userId]);
    return rows[0] || null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const rows = await query<User>('SELECT * FROM users WHERE username = $1', [username]);
    return rows[0] || null;
  }

  async createUser(
    username: string,
    displayName: string,
    avatarUrl?: string
  ): Promise<User> {
    const rows = await query<User>(
      `INSERT INTO users (username, display_name, avatar_url)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [username, displayName, avatarUrl || null]
    );
    return rows[0];
  }

  async updateReputation(userId: string, delta: number): Promise<void> {
    await query(
      `UPDATE users SET
         reputation_score = GREATEST(0, LEAST(1, reputation_score + $1)),
         updated_at = NOW()
       WHERE id = $2`,
      [delta, userId]
    );
  }

  async isBanned(userId: string, streamId?: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `SELECT id FROM user_bans
       WHERE user_id = $1
         AND (stream_id IS NULL OR stream_id = $2)
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [userId, streamId || null]
    );
    return rows.length > 0;
  }

  async banUser(
    userId: string,
    bannedBy: string,
    reason?: string,
    streamId?: string,
    expiresAt?: Date
  ): Promise<void> {
    await query(
      `INSERT INTO user_bans (user_id, stream_id, banned_by, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, streamId || null, bannedBy, reason || null, expiresAt || null]
    );
  }

  async unbanUser(userId: string, streamId?: string): Promise<void> {
    if (streamId) {
      await query(
        'DELETE FROM user_bans WHERE user_id = $1 AND stream_id = $2',
        [userId, streamId]
      );
    } else {
      await query('DELETE FROM user_bans WHERE user_id = $1', [userId]);
    }
  }

  async getAllUsers(): Promise<User[]> {
    return query<User>('SELECT * FROM users ORDER BY created_at DESC');
  }
}

export const userService = new UserService();
