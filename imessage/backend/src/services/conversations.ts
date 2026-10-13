import { PoolClient } from 'pg';
import { query, transaction } from '../db.js';

interface Participant {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role?: string;
}

interface LastMessage {
  id: string;
  seq: number;
  content: string;
  content_type: string;
  sender_id: string;
  created_at: Date;
}

interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
  role?: string;
  muted?: boolean;
  last_message?: LastMessage | null;
  unread_count?: number;
  participants?: Participant[];
}

export async function getConversations(userId: string): Promise<Conversation[]> {
  const result = await query<Conversation>(
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
          'seq', m.seq,
          'content', m.content,
          'content_type', m.content_type,
          'sender_id', m.sender_id,
          'created_at', m.created_at
        )
        FROM messages m
        WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
        ORDER BY m.seq DESC
        LIMIT 1
      ) as last_message,
      -- Unread = messages from others above the user's read watermark (the
      -- highest seq read on any of their devices), not "newer than the time
      -- I last read something", which miscounts messages that arrived
      -- while an older one was being read.
      (
        SELECT COUNT(*)::int
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.deleted_at IS NULL
          AND m.sender_id IS DISTINCT FROM $1
          AND m.seq > COALESCE(
            (SELECT MAX(rr.last_read_seq) FROM read_receipts rr
             WHERE rr.conversation_id = c.id AND rr.user_id = $1),
            0
          )
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

export async function getConversation(
  conversationId: string,
  userId: string
): Promise<Conversation | null> {
  const result = await query<Conversation>(
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

const FIND_DIRECT_SQL = `SELECT c.id FROM conversations c
  JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
  JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2
  WHERE c.type = 'direct' AND cp1.left_at IS NULL AND cp2.left_at IS NULL
  LIMIT 1`;

export async function createDirectConversation(
  userId: string,
  otherUserId: string
): Promise<Conversation | null> {
  // Fast path: the conversation usually exists already
  const existing = await query<{ id: string }>(FIND_DIRECT_SQL, [userId, otherUserId]);
  if (existing.rows.length > 0) {
    return await getConversation(existing.rows[0].id, userId);
  }

  type Outcome = { existingId: string } | { conversation: Conversation };
  const created = await transaction<Outcome>(async (client: PoolClient) => {
    // Check-then-insert races when both people start the chat at once. A
    // transaction-scoped advisory lock on the (sorted) pair serializes the
    // two requests, and the second one finds the first one's conversation.
    const pairKey = [userId, otherUserId].sort().join(':');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pairKey]);
    const again = await client.query<{ id: string }>(FIND_DIRECT_SQL, [userId, otherUserId]);
    if (again.rows.length > 0) {
      return { existingId: again.rows[0].id };
    }

    const conversationResult = await client.query<Conversation>(
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
    const participantsResult = await client.query<Participant>(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM users u WHERE u.id IN ($1, $2)`,
      [userId, otherUserId]
    );

    return {
      conversation: {
        ...conversation,
        participants: participantsResult.rows,
      },
    };
  });

  if ('existingId' in created) {
    return await getConversation(created.existingId, userId);
  }
  return created.conversation;
}

export async function createGroupConversation(
  userId: string,
  name: string,
  participantIds: string[]
): Promise<Conversation> {
  return await transaction(async (client: PoolClient) => {
    const conversationResult = await client.query<Conversation>(
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
    const filteredParticipantIds = participantIds.filter(id => id !== userId);
    if (filteredParticipantIds.length > 0) {
      const values = filteredParticipantIds
        .map((_, i) => `($1, $${i + 2}, 'member')`)
        .join(', ');

      if (values) {
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id, role)
           VALUES ${values}`,
          [conversation.id, ...filteredParticipantIds]
        );
      }
    }

    // Get participants
    const participantsResult = await client.query<Participant>(
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

export async function addParticipant(
  conversationId: string,
  userId: string,
  addedBy: string
): Promise<void> {
  // Check if adder is admin
  const adminCheck = await query<{ role: string }>(
    `SELECT role FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, addedBy]
  );

  if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
    throw new Error('Only admins can add participants');
  }

  // Direct conversations have exactly two members by definition
  const typeCheck = await query<{ type: string }>(
    'SELECT type FROM conversations WHERE id = $1',
    [conversationId]
  );
  if (typeCheck.rows[0]?.type !== 'group') {
    throw new Error('Participants can only be added to group conversations');
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

export async function removeParticipant(
  conversationId: string,
  userId: string,
  removedBy: string
): Promise<void> {
  // Allow self-removal or admin removal
  if (userId !== removedBy) {
    const adminCheck = await query<{ role: string }>(
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

export async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, userId]
  );
  return result.rows.length > 0;
}

export async function getParticipantIds(conversationId: string): Promise<string[]> {
  const result = await query<{ user_id: string }>(
    `SELECT user_id FROM conversation_participants
     WHERE conversation_id = $1 AND left_at IS NULL`,
    [conversationId]
  );
  return result.rows.map(r => r.user_id);
}

/** Users who share at least one active conversation with this user (presence audience). */
export async function getConversationPeerIds(userId: string): Promise<string[]> {
  const result = await query<{ user_id: string }>(
    `SELECT DISTINCT peer.user_id
     FROM conversation_participants mine
     JOIN conversation_participants peer
       ON peer.conversation_id = mine.conversation_id AND peer.left_at IS NULL
     WHERE mine.user_id = $1 AND mine.left_at IS NULL AND peer.user_id <> $1`,
    [userId]
  );
  return result.rows.map(r => r.user_id);
}
