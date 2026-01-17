import { v4 as uuid } from 'uuid';
import { query, transaction } from '../db.js';

export async function getConversations(userId) {
  const result = await query(
    `SELECT
      c.id,
      c.type,
      c.name,
      c.avatar_url,
      c.created_at,
      c.updated_at,
      cp.role,
      cp.muted,
      (
        SELECT json_build_object(
          'id', m.id,
          'content', m.content,
          'content_type', m.content_type,
          'sender_id', m.sender_id,
          'created_at', m.created_at
        )
        FROM messages m
        WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT 1
      ) as last_message,
      (
        SELECT COUNT(*)::int
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.deleted_at IS NULL
          AND m.created_at > COALESCE(
            (SELECT last_read_at FROM read_receipts rr
             WHERE rr.conversation_id = c.id AND rr.user_id = $1
             ORDER BY last_read_at DESC LIMIT 1),
            '1970-01-01'
          )
          AND m.sender_id != $1
      ) as unread_count,
      (
        SELECT json_agg(json_build_object(
          'id', u.id,
          'username', u.username,
          'display_name', u.display_name,
          'avatar_url', u.avatar_url
        ))
        FROM conversation_participants cp2
        JOIN users u ON u.id = cp2.user_id
        WHERE cp2.conversation_id = c.id AND cp2.left_at IS NULL
      ) as participants
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE cp.user_id = $1 AND cp.left_at IS NULL
    ORDER BY c.updated_at DESC`,
    [userId]
  );

  return result.rows;
}

export async function getConversation(conversationId, userId) {
  const result = await query(
    `SELECT
      c.id,
      c.type,
      c.name,
      c.avatar_url,
      c.created_at,
      c.updated_at,
      cp.role,
      cp.muted,
      (
        SELECT json_agg(json_build_object(
          'id', u.id,
          'username', u.username,
          'display_name', u.display_name,
          'avatar_url', u.avatar_url,
          'role', cp2.role
        ))
        FROM conversation_participants cp2
        JOIN users u ON u.id = cp2.user_id
        WHERE cp2.conversation_id = c.id AND cp2.left_at IS NULL
      ) as participants
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE c.id = $1 AND cp.user_id = $2 AND cp.left_at IS NULL`,
    [conversationId, userId]
  );

  return result.rows[0] || null;
}

export async function createDirectConversation(userId, otherUserId) {
  // Check if direct conversation already exists
  const existing = await query(
    `SELECT c.id FROM conversations c
     JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
     JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2
     WHERE c.type = 'direct' AND cp1.left_at IS NULL AND cp2.left_at IS NULL`,
    [userId, otherUserId]
  );

  if (existing.rows.length > 0) {
    return await getConversation(existing.rows[0].id, userId);
  }

  return await transaction(async (client) => {
    const conversationResult = await client.query(
      `INSERT INTO conversations (type, created_by)
       VALUES ('direct', $1)
       RETURNING id, type, name, avatar_url, created_at, updated_at`,
      [userId]
    );

    const conversation = conversationResult.rows[0];

    // Add both participants
    await client.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [conversation.id, userId, otherUserId]
    );

    // Get participants
    const participantsResult = await client.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM users u WHERE u.id IN ($1, $2)`,
      [userId, otherUserId]
    );

    return {
      ...conversation,
      participants: participantsResult.rows,
    };
  });
}

export async function createGroupConversation(userId, name, participantIds) {
  return await transaction(async (client) => {
    const conversationResult = await client.query(
      `INSERT INTO conversations (type, name, created_by)
       VALUES ('group', $1, $2)
       RETURNING id, type, name, avatar_url, created_at, updated_at`,
      [name, userId]
    );

    const conversation = conversationResult.rows[0];

    // Add creator as admin
    await client.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [conversation.id, userId]
    );

    // Add other participants
    if (participantIds.length > 0) {
      const values = participantIds
        .filter(id => id !== userId)
        .map((id, i) => `($1, $${i + 2}, 'member')`)
        .join(', ');

      if (values) {
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id, role)
           VALUES ${values}`,
          [conversation.id, ...participantIds.filter(id => id !== userId)]
        );
      }
    }

    // Get participants
    const participantsResult = await client.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, cp.role
       FROM conversation_participants cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.conversation_id = $1 AND cp.left_at IS NULL`,
      [conversation.id]
    );

    return {
      ...conversation,
      participants: participantsResult.rows,
    };
  });
}

export async function addParticipant(conversationId, userId, addedBy) {
  // Check if adder is admin
  const adminCheck = await query(
    `SELECT role FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, addedBy]
  );

  if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
    throw new Error('Only admins can add participants');
  }

  await query(
    `INSERT INTO conversation_participants (conversation_id, user_id, role)
     VALUES ($1, $2, 'member')
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET left_at = NULL`,
    [conversationId, userId]
  );

  // Update conversation timestamp
  await query(
    'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
    [conversationId]
  );
}

export async function removeParticipant(conversationId, userId, removedBy) {
  // Allow self-removal or admin removal
  if (userId !== removedBy) {
    const adminCheck = await query(
      `SELECT role FROM conversation_participants
       WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [conversationId, removedBy]
    );

    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
      throw new Error('Only admins can remove participants');
    }
  }

  await query(
    `UPDATE conversation_participants
     SET left_at = NOW()
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );

  // Update conversation timestamp
  await query(
    'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
    [conversationId]
  );
}

export async function isParticipant(conversationId, userId) {
  const result = await query(
    `SELECT 1 FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, userId]
  );
  return result.rows.length > 0;
}

export async function getParticipantIds(conversationId) {
  const result = await query(
    `SELECT user_id FROM conversation_participants
     WHERE conversation_id = $1 AND left_at IS NULL`,
    [conversationId]
  );
  return result.rows.map(r => r.user_id);
}
