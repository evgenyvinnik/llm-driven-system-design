import { query } from '../db/index.js';
import redis from '../db/redis.js';
import { updatePostScore } from './post.js';
import { updateCommentScore } from './comment.js';
import { updateUserKarma } from './user.js';
import logger from '../shared/logger.js';
import { voteTotal, karmaCalculationDuration } from '../shared/metrics.js';

export const castVote = async (userId, targetType, targetId, direction) => {
  // direction: 1 = upvote, -1 = downvote, 0 = remove vote

  const isPost = targetType === 'post';
  const column = isPost ? 'post_id' : 'comment_id';
  const otherColumn = isPost ? 'comment_id' : 'post_id';

  // Check existing vote
  const existingResult = await query(
    `SELECT id, direction FROM votes WHERE user_id = $1 AND ${column} = $2`,
    [userId, targetId]
  );

  const existingVote = existingResult.rows[0];

  if (direction === 0) {
    // Remove vote
    if (existingVote) {
      await query(`DELETE FROM votes WHERE id = $1`, [existingVote.id]);
      logger.debug({ userId, targetType, targetId }, 'Vote removed');
    }
  } else if (existingVote) {
    // Update existing vote
    if (existingVote.direction !== direction) {
      await query(
        `UPDATE votes SET direction = $1, created_at = NOW() WHERE id = $2`,
        [direction, existingVote.id]
      );
      logger.debug({ userId, targetType, targetId, direction }, 'Vote changed');
    }
    // If same direction, do nothing
  } else {
    // Create new vote
    await query(
      `INSERT INTO votes (user_id, ${column}, ${otherColumn}, direction)
       VALUES ($1, $2, NULL, $3)`,
      [userId, targetId, direction]
    );

    // Record metric for new votes
    const directionLabel = direction === 1 ? 'up' : 'down';
    voteTotal.inc({ direction: directionLabel, target_type: targetType });

    logger.debug({ userId, targetType, targetId, direction }, 'Vote cast');
  }

  // Immediately aggregate for this target (for responsive UI)
  await aggregateVotesForTarget(targetType, targetId);

  // Cache vote in Redis for quick user vote lookup
  const cacheKey = `vote:${userId}:${targetType}:${targetId}`;
  if (direction === 0) {
    await redis.del(cacheKey);
  } else {
    await redis.setex(cacheKey, 3600, direction.toString());
  }

  return { success: true };
};

export const getUserVote = async (userId, targetType, targetId) => {
  // Check Redis cache first
  const cacheKey = `vote:${userId}:${targetType}:${targetId}`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return parseInt(cached, 10);
  }

  const column = targetType === 'post' ? 'post_id' : 'comment_id';
  const result = await query(
    `SELECT direction FROM votes WHERE user_id = $1 AND ${column} = $2`,
    [userId, targetId]
  );

  const direction = result.rows[0]?.direction ?? 0;

  // Cache the result
  await redis.setex(cacheKey, 3600, direction.toString());

  return direction;
};

export const getUserVotesForPosts = async (userId, postIds) => {
  if (!postIds.length) return {};

  const result = await query(
    `SELECT post_id, direction FROM votes WHERE user_id = $1 AND post_id = ANY($2)`,
    [userId, postIds]
  );

  const votes = {};
  for (const row of result.rows) {
    votes[row.post_id] = row.direction;
  }
  return votes;
};

export const getUserVotesForComments = async (userId, commentIds) => {
  if (!commentIds.length) return {};

  const result = await query(
    `SELECT comment_id, direction FROM votes WHERE user_id = $1 AND comment_id = ANY($2)`,
    [userId, commentIds]
  );

  const votes = {};
  for (const row of result.rows) {
    votes[row.comment_id] = row.direction;
  }
  return votes;
};

export const aggregateVotesForTarget = async (targetType, targetId) => {
  const column = targetType === 'post' ? 'post_id' : 'comment_id';

  const result = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 1 THEN 1 ELSE 0 END), 0) as upvotes,
       COALESCE(SUM(CASE WHEN direction = -1 THEN 1 ELSE 0 END), 0) as downvotes
     FROM votes
     WHERE ${column} = $1`,
    [targetId]
  );

  const { upvotes, downvotes } = result.rows[0];

  if (targetType === 'post') {
    await updatePostScore(targetId, parseInt(upvotes), parseInt(downvotes));

    // Update author karma
    const start = Date.now();
    const postResult = await query(`SELECT author_id FROM posts WHERE id = $1`, [targetId]);
    if (postResult.rows[0]?.author_id) {
      await updateUserKarma(postResult.rows[0].author_id);
      karmaCalculationDuration.observe((Date.now() - start) / 1000);
    }
  } else {
    await updateCommentScore(targetId, parseInt(upvotes), parseInt(downvotes));

    // Update author karma
    const start = Date.now();
    const commentResult = await query(`SELECT author_id FROM comments WHERE id = $1`, [targetId]);
    if (commentResult.rows[0]?.author_id) {
      await updateUserKarma(commentResult.rows[0].author_id);
      karmaCalculationDuration.observe((Date.now() - start) / 1000);
    }
  }
};

// Background aggregation for all pending votes
export const aggregateAllVotes = async () => {
  // Get all posts with votes in the last interval
  const postsResult = await query(`
    SELECT DISTINCT post_id FROM votes
    WHERE post_id IS NOT NULL
      AND created_at > NOW() - INTERVAL '1 minute'
  `);

  for (const row of postsResult.rows) {
    await aggregateVotesForTarget('post', row.post_id);
  }

  // Get all comments with votes in the last interval
  const commentsResult = await query(`
    SELECT DISTINCT comment_id FROM votes
    WHERE comment_id IS NOT NULL
      AND created_at > NOW() - INTERVAL '1 minute'
  `);

  for (const row of commentsResult.rows) {
    await aggregateVotesForTarget('comment', row.comment_id);
  }

  return {
    postsAggregated: postsResult.rowCount,
    commentsAggregated: commentsResult.rowCount,
  };
};
