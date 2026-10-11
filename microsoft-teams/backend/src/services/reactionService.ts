import { withTransaction, RollbackWith } from './db.js';
import { appendChannelEvent, nextChannelSeq, type ChannelEvent } from './channelEvents.js';

interface ReactionChange {
  channelId: string;
  messageId: string;
  userId: string;
  username: string;
  emoji: string;
}

/**
 * Adds a reaction and logs `reaction_added`, but only if the row is new. Repeating the request is
 * a no-op that emits nothing (and returns null), so viewers' counts cannot drift the way they did
 * when every attempt was broadcast. The not-deleted check runs after the channel lock is taken,
 * so it cannot race a concurrent delete.
 */
export async function addReaction(change: ReactionChange): Promise<ChannelEvent | null> {
  return withTransaction(async (client) => {
    const seq = await nextChannelSeq(client, change.channelId);
    const { rowCount } = await client.query(
      `INSERT INTO message_reactions (message_id, user_id, emoji)
       SELECT $1, $2, $3
        WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1 AND deleted_at IS NULL)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
      [change.messageId, change.userId, change.emoji],
    );
    if (rowCount === 0) return new RollbackWith(null);
    return appendChannelEvent(client, change.channelId, seq, 'reaction_added', {
      messageId: change.messageId,
      emoji: change.emoji,
      userId: change.userId,
      username: change.username,
    });
  });
}

/** Removes a reaction and logs `reaction_removed` only if a row was actually deleted. */
export async function removeReaction(change: ReactionChange): Promise<ChannelEvent | null> {
  return withTransaction(async (client) => {
    const seq = await nextChannelSeq(client, change.channelId);
    const { rowCount } = await client.query(
      `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [change.messageId, change.userId, change.emoji],
    );
    if (rowCount === 0) return new RollbackWith(null);
    return appendChannelEvent(client, change.channelId, seq, 'reaction_removed', {
      messageId: change.messageId,
      emoji: change.emoji,
      userId: change.userId,
      username: change.username,
    });
  });
}
