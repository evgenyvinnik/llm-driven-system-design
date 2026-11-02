import { pool } from './db.js';
import { logger } from './logger.js';

export const MAX_CHAT_LENGTH = 2000;

/** Wire shape shared by live chat messages and chat history. */
export interface ChatMessageDto {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  recipientId: string | null;
  createdAt: string;
}

/** Persists a chat message to the database, supporting optional direct messages. */
export async function saveMessage(
  meetingId: string,
  senderId: string,
  content: string,
  recipientId?: string | null
) {
  const result = await pool.query(
    `INSERT INTO meeting_chat_messages (meeting_id, sender_id, content, recipient_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [meetingId, senderId, content, recipientId || null]
  );
  logger.debug({ meetingId, senderId, recipientId }, 'Chat message saved');
  return result.rows[0];
}

/**
 * Chat history as one viewer may see it: messages to everyone, plus direct
 * messages the viewer sent or received. The old query returned every row,
 * including private DMs between other participants, to anyone who asked.
 * Returns the most recent `limit` messages, oldest first.
 */
export async function getMessagesForViewer(
  meetingId: string,
  viewerId: string,
  limit = 100
): Promise<ChatMessageDto[]> {
  const result = await pool.query(
    `SELECT * FROM (
       SELECT m.id, m.sender_id, m.recipient_id, m.content, m.created_at,
              COALESCE(u.display_name, u.username) AS sender_name
       FROM meeting_chat_messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.meeting_id = $1
         AND (m.recipient_id IS NULL OR m.sender_id = $2 OR m.recipient_id = $2)
       ORDER BY m.created_at DESC
       LIMIT $3
     ) recent
     ORDER BY created_at ASC`,
    [meetingId, viewerId, limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    content: row.content,
    recipientId: row.recipient_id,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
