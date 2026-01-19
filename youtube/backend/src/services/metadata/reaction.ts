import { PoolClient } from 'pg';
import { query, transaction } from '../../utils/db.js';
import { cacheDelete, updateTrendingScore } from '../../utils/redis.js';
import { ReactionResult, calculateTrendingScore } from './types.js';
import { getVideo } from './video.js';

/**
 * @description Adds, changes, or removes a reaction (like/dislike) on a video.
 * Uses a database transaction to ensure consistency between the reaction record
 * and the video's like/dislike counts. Also updates the video's trending score.
 *
 * Behavior:
 * - If no existing reaction: adds the new reaction
 * - If same reaction exists: removes the reaction (toggle off)
 * - If different reaction exists: changes from one reaction to the other
 *
 * @param userId - The UUID of the user reacting
 * @param videoId - The UUID of the video being reacted to
 * @param reactionType - The type of reaction: 'like' or 'dislike'
 * @returns Result containing the current reaction state
 * @throws Error if reactionType is not 'like' or 'dislike'
 */
export const reactToVideo = async (
  userId: string,
  videoId: string,
  reactionType: string
): Promise<ReactionResult> => {
  if (!['like', 'dislike'].includes(reactionType)) {
    throw new Error('Invalid reaction type');
  }

  await transaction(async (client: PoolClient): Promise<void> => {
    // Check existing reaction
    const existing = await client.query<{ reaction_type: string }>(
      'SELECT reaction_type FROM video_reactions WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );

    const existingRow = existing.rows[0];
    if (existingRow) {
      const oldReaction = existingRow.reaction_type;

      if (oldReaction === reactionType) {
        // Remove reaction
        await client.query('DELETE FROM video_reactions WHERE user_id = $1 AND video_id = $2', [
          userId,
          videoId,
        ]);

        const countColumn = reactionType === 'like' ? 'like_count' : 'dislike_count';
        await client.query(`UPDATE videos SET ${countColumn} = ${countColumn} - 1 WHERE id = $1`, [
          videoId,
        ]);
      } else {
        // Change reaction
        await client.query(
          'UPDATE video_reactions SET reaction_type = $1 WHERE user_id = $2 AND video_id = $3',
          [reactionType, userId, videoId]
        );

        const oldColumn = oldReaction === 'like' ? 'like_count' : 'dislike_count';
        const newColumn = reactionType === 'like' ? 'like_count' : 'dislike_count';

        await client.query(
          `UPDATE videos SET ${oldColumn} = ${oldColumn} - 1, ${newColumn} = ${newColumn} + 1 WHERE id = $1`,
          [videoId]
        );
      }
    } else {
      // New reaction
      await client.query(
        'INSERT INTO video_reactions (user_id, video_id, reaction_type) VALUES ($1, $2, $3)',
        [userId, videoId, reactionType]
      );

      const countColumn = reactionType === 'like' ? 'like_count' : 'dislike_count';
      await client.query(`UPDATE videos SET ${countColumn} = ${countColumn} + 1 WHERE id = $1`, [
        videoId,
      ]);
    }
  });

  // Update trending score
  const video = await getVideo(videoId);
  if (video) {
    const score = calculateTrendingScore(video);
    await updateTrendingScore(videoId, score);
  }

  // Invalidate cache
  await cacheDelete(`video:${videoId}`);

  return { reaction: reactionType };
};

/**
 * @description Retrieves the current user's reaction to a specific video.
 * @param userId - The UUID of the user to check
 * @param videoId - The UUID of the video to check reaction for
 * @returns The reaction type ('like' or 'dislike'), or null if no reaction exists
 */
export const getUserReaction = async (
  userId: string,
  videoId: string
): Promise<string | null> => {
  const result = await query<{ reaction_type: string }>(
    'SELECT reaction_type FROM video_reactions WHERE user_id = $1 AND video_id = $2',
    [userId, videoId]
  );

  const row = result.rows[0];
  return row ? row.reaction_type : null;
};
