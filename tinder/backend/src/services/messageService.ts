import { pool, redis } from '../db/index.js';
import type { Message, ConversationMessage } from '../types/index.js';
import { MatchService } from './matchService.js';

export class MessageService {
  private matchService: MatchService;

  constructor() {
    this.matchService = new MatchService();
  }

  // Send a message
  async sendMessage(
    matchId: string,
    senderId: string,
    content: string
  ): Promise<Message | null> {
    // Verify sender is part of this match
    const match = await this.matchService.getMatchById(matchId);
    if (!match) {
      return null;
    }

    if (match.user1_id !== senderId && match.user2_id !== senderId) {
      return null;
    }

    // Insert message
    const result = await pool.query(
      `INSERT INTO messages (match_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [matchId, senderId, content]
    );

    const message = result.rows[0];

    // Update last message timestamp on match
    await pool.query(
      'UPDATE matches SET last_message_at = NOW() WHERE id = $1',
      [matchId]
    );

    // Publish to Redis for real-time delivery
    const recipientId = match.user1_id === senderId ? match.user2_id : match.user1_id;
    await this.publishMessage(recipientId, matchId, message);

    return message;
  }

  // Get messages for a match
  async getMessages(
    matchId: string,
    userId: string,
    limit: number = 50,
    before?: string
  ): Promise<ConversationMessage[]> {
    // Verify user is part of this match
    const match = await this.matchService.getMatchById(matchId);
    if (!match || (match.user1_id !== userId && match.user2_id !== userId)) {
      return [];
    }

    let query = `
      SELECT id, sender_id, content, sent_at, read_at
      FROM messages
      WHERE match_id = $1
    `;
    const params: (string | number)[] = [matchId];

    if (before) {
      query += ' AND sent_at < $2';
      params.push(before);
    }

    query += ' ORDER BY sent_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await pool.query(query, params);

    // Mark messages as read
    await this.markAsRead(matchId, userId);

    return result.rows.map((row) => ({
      id: row.id,
      sender_id: row.sender_id,
      content: row.content,
      sent_at: row.sent_at,
      read_at: row.read_at,
      is_mine: row.sender_id === userId,
    }));
  }

  // Mark messages as read
  async markAsRead(matchId: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE messages
       SET read_at = NOW()
       WHERE match_id = $1 AND sender_id != $2 AND read_at IS NULL`,
      [matchId, userId]
    );
  }

  // Get unread message count
  async getUnreadCount(userId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) FROM messages m
       JOIN matches ma ON m.match_id = ma.id
       WHERE (ma.user1_id = $1 OR ma.user2_id = $1)
         AND m.sender_id != $1
         AND m.read_at IS NULL`,
      [userId]
    );

    return parseInt(result.rows[0].count);
  }

  // Get unread count per match
  async getUnreadCountByMatch(userId: string): Promise<Map<string, number>> {
    const result = await pool.query(
      `SELECT m.match_id, COUNT(*) as unread
       FROM messages m
       JOIN matches ma ON m.match_id = ma.id
       WHERE (ma.user1_id = $1 OR ma.user2_id = $1)
         AND m.sender_id != $1
         AND m.read_at IS NULL
       GROUP BY m.match_id`,
      [userId]
    );

    const counts = new Map<string, number>();
    for (const row of result.rows) {
      counts.set(row.match_id, parseInt(row.unread));
    }
    return counts;
  }

  // Publish message to Redis for real-time delivery
  private async publishMessage(
    recipientId: string,
    matchId: string,
    message: Message
  ): Promise<void> {
    const payload = JSON.stringify({
      type: 'new_message',
      match_id: matchId,
      message: {
        id: message.id,
        sender_id: message.sender_id,
        content: message.content,
        sent_at: message.sent_at,
      },
    });

    await redis.publish(`user:${recipientId}`, payload);
  }

  // Publish match notification
  async publishMatchNotification(
    userId: string,
    matchId: string,
    matchedUser: { id: string; name: string; primary_photo: string | null }
  ): Promise<void> {
    const payload = JSON.stringify({
      type: 'new_match',
      match_id: matchId,
      user: matchedUser,
    });

    await redis.publish(`user:${userId}`, payload);
  }

  // Get message stats for admin
  async getMessageStats(): Promise<{
    totalMessages: number;
    messagesToday: number;
    avgMessagesPerMatch: number;
  }> {
    const [total, today, matchCount] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM messages'),
      pool.query("SELECT COUNT(*) FROM messages WHERE sent_at >= NOW() - INTERVAL '1 day'"),
      pool.query('SELECT COUNT(*) FROM matches WHERE last_message_at IS NOT NULL'),
    ]);

    const totalMessages = parseInt(total.rows[0].count);
    const matchesWithMessages = parseInt(matchCount.rows[0].count);

    return {
      totalMessages,
      messagesToday: parseInt(today.rows[0].count),
      avgMessagesPerMatch: matchesWithMessages > 0 ? totalMessages / matchesWithMessages : 0,
    };
  }
}
