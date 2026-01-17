import { pool } from '../db.js';
import { redis, KEYS } from '../redis.js';
import { Conversation, ConversationParticipant, User } from '../types/index.js';

export async function createDirectConversation(
  userId1: string,
  userId2: string
): Promise<Conversation> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check if conversation already exists
    const existingResult = await client.query(
      `SELECT c.* FROM conversations c
       JOIN conversation_participants cp1 ON c.id = cp1.conversation_id
       JOIN conversation_participants cp2 ON c.id = cp2.conversation_id
       WHERE c.is_group = false
       AND cp1.user_id = $1 AND cp2.user_id = $2`,
      [userId1, userId2]
    );

    if (existingResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return existingResult.rows[0];
    }

    // Create new conversation
    const convResult = await client.query(
      `INSERT INTO conversations (is_group, created_by)
       VALUES (false, $1)
       RETURNING *`,
      [userId1]
    );
    const conversation = convResult.rows[0];

    // Add participants
    await client.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [conversation.id, userId1, userId2]
    );

    await client.query('COMMIT');

    return conversation;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createGroupConversation(
  name: string,
  creatorId: string,
  memberIds: string[]
): Promise<Conversation> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Create conversation
    const convResult = await client.query(
      `INSERT INTO conversations (name, is_group, created_by)
       VALUES ($1, true, $2)
       RETURNING *`,
      [name, creatorId]
    );
    const conversation = convResult.rows[0];

    // Add creator as admin
    await client.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [conversation.id, creatorId]
    );

    // Add other members
    const allMemberIds = [...new Set([...memberIds.filter((id) => id !== creatorId)])];
    for (const memberId of allMemberIds) {
      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [conversation.id, memberId]
      );
    }

    // Cache group members in Redis
    await redis.sadd(KEYS.groupMembers(conversation.id), creatorId, ...allMemberIds);

    await client.query('COMMIT');

    return conversation;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getConversationById(conversationId: string): Promise<Conversation | null> {
  const result = await pool.query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
  return result.rows[0] || null;
}

export async function getConversationsForUser(userId: string): Promise<Conversation[]> {
  const result = await pool.query(
    `SELECT
      c.*,
      (
        SELECT json_agg(
          json_build_object(
            'id', cp.id,
            'user_id', cp.user_id,
            'role', cp.role,
            'user', json_build_object(
              'id', u.id,
              'username', u.username,
              'display_name', u.display_name,
              'profile_picture_url', u.profile_picture_url
            )
          )
        )
        FROM conversation_participants cp
        JOIN users u ON cp.user_id = u.id
        WHERE cp.conversation_id = c.id
      ) as participants,
      (
        SELECT json_build_object(
          'id', m.id,
          'content', m.content,
          'sender_id', m.sender_id,
          'created_at', m.created_at
        )
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) as last_message,
      (
        SELECT COUNT(*)::int
        FROM messages m
        JOIN message_status ms ON m.id = ms.message_id
        WHERE m.conversation_id = c.id
        AND ms.recipient_id = $1
        AND ms.status != 'read'
      ) as unread_count
     FROM conversations c
     JOIN conversation_participants cp ON c.id = cp.conversation_id
     WHERE cp.user_id = $1
     ORDER BY c.updated_at DESC`,
    [userId]
  );

  return result.rows;
}

export async function getConversationParticipants(
  conversationId: string
): Promise<ConversationParticipant[]> {
  const result = await pool.query(
    `SELECT cp.*,
            json_build_object(
              'id', u.id,
              'username', u.username,
              'display_name', u.display_name,
              'profile_picture_url', u.profile_picture_url
            ) as user
     FROM conversation_participants cp
     JOIN users u ON cp.user_id = u.id
     WHERE cp.conversation_id = $1`,
    [conversationId]
  );
  return result.rows;
}

export async function isUserInConversation(
  userId: string,
  conversationId: string
): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE user_id = $1 AND conversation_id = $2',
    [userId, conversationId]
  );
  return result.rows.length > 0;
}

export async function getOtherParticipant(
  conversationId: string,
  userId: string
): Promise<User | null> {
  const result = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.profile_picture_url
     FROM conversation_participants cp
     JOIN users u ON cp.user_id = u.id
     WHERE cp.conversation_id = $1 AND cp.user_id != $2`,
    [conversationId, userId]
  );
  return result.rows[0] || null;
}

export async function addUserToGroup(
  conversationId: string,
  userId: string,
  role: 'admin' | 'member' = 'member'
): Promise<void> {
  await pool.query(
    `INSERT INTO conversation_participants (conversation_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [conversationId, userId, role]
  );

  // Update Redis cache
  await redis.sadd(KEYS.groupMembers(conversationId), userId);
}

export async function removeUserFromGroup(conversationId: string, userId: string): Promise<void> {
  await pool.query(
    'DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );

  // Update Redis cache
  await redis.srem(KEYS.groupMembers(conversationId), userId);
}
