import { query } from '../db.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('embeddings');

// Embedding dimension (384 is common for sentence transformers like all-MiniLM-L6-v2)
const EMBEDDING_DIM = 384;

/**
 * Generate a random embedding vector (simulating an ML model).
 * In production, this would call a real embedding model (e.g., sentence-transformers).
 * @returns {number[]} A normalized 384-dimensional vector
 */
function generateRandomEmbedding() {
  const embedding = [];
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    embedding.push(Math.random() * 2 - 1); // Values between -1 and 1
  }
  // Normalize to unit length for cosine similarity
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  return embedding.map(val => val / magnitude);
}

/**
 * Convert embedding array to pgvector format string.
 * @param {number[]} embedding - The embedding array
 * @returns {string} PostgreSQL vector format '[x,y,z,...]'
 */
function toPgVector(embedding) {
  return '[' + embedding.join(',') + ']';
}

/**
 * Parse pgvector format string to array.
 * @param {string} vectorStr - PostgreSQL vector format '[x,y,z,...]'
 * @returns {number[]} The embedding array
 */
function fromPgVector(vectorStr) {
  if (!vectorStr) return null;
  // Handle both string and already-parsed array formats
  if (Array.isArray(vectorStr)) return vectorStr;
  return vectorStr.slice(1, -1).split(',').map(Number);
}

/**
 * Generate and store video embedding based on description and hashtags.
 * In production, this would use the actual video content, audio, and visual features.
 * @param {number} videoId - The video ID
 * @param {string} description - Video description text
 * @param {string[]} hashtags - Video hashtags
 * @returns {Promise<number[]>} The generated embedding
 */
export async function generateVideoEmbedding(videoId, description = '', hashtags = []) {
  try {
    // Simulate text-based embedding generation
    // In production: call sentence-transformers or similar model with description + hashtags
    const embedding = generateRandomEmbedding();

    // Store the embedding
    await query(
      'UPDATE videos SET embedding = $1 WHERE id = $2',
      [toPgVector(embedding), videoId]
    );

    logger.debug({ videoId }, 'Video embedding generated and stored');
    return embedding;
  } catch (error) {
    logger.error({ error: error.message, videoId }, 'Failed to generate video embedding');
    throw error;
  }
}

/**
 * Generate user interest embedding based on watch history.
 * This aggregates embeddings of watched videos weighted by engagement.
 * @param {number} userId - The user ID
 * @param {Array<{videoId: number, completionRate: number, liked: boolean}>} watchHistory - Recent watch history
 * @returns {Promise<number[]>} The generated user interest embedding
 */
export async function generateUserEmbedding(userId, watchHistory = []) {
  try {
    if (!watchHistory || watchHistory.length === 0) {
      // If no history, fetch from database
      const historyResult = await query(
        `SELECT video_id, completion_rate, liked FROM watch_history 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT 100`,
        [userId]
      );
      watchHistory = historyResult.rows.map(r => ({
        videoId: r.video_id,
        completionRate: r.completion_rate || 0,
        liked: r.liked || false,
      }));
    }

    if (watchHistory.length === 0) {
      // No history yet, generate random embedding for cold start
      const embedding = generateRandomEmbedding();
      await query(
        'UPDATE users SET interest_embedding = $1 WHERE id = $2',
        [toPgVector(embedding), userId]
      );
      logger.debug({ userId }, 'Cold start user embedding generated');
      return embedding;
    }

    // Get embeddings for watched videos
    const videoIds = watchHistory.map(h => h.videoId);
    const videosResult = await query(
      'SELECT id, embedding FROM videos WHERE id = ANY($1) AND embedding IS NOT NULL',
      [videoIds]
    );

    const videoEmbeddings = new Map();
    for (const row of videosResult.rows) {
      const emb = fromPgVector(row.embedding);
      if (emb) {
        videoEmbeddings.set(row.id, emb);
      }
    }

    if (videoEmbeddings.size === 0) {
      // No video embeddings available, generate random
      const embedding = generateRandomEmbedding();
      await query(
        'UPDATE users SET interest_embedding = $1 WHERE id = $2',
        [toPgVector(embedding), userId]
      );
      return embedding;
    }

    // Weighted average of video embeddings
    const aggregatedEmbedding = new Array(EMBEDDING_DIM).fill(0);
    let totalWeight = 0;

    for (const historyItem of watchHistory) {
      const videoEmb = videoEmbeddings.get(historyItem.videoId);
      if (!videoEmb) continue;

      // Weight: completion rate (0-1) + liked bonus (0.5)
      const weight = (historyItem.completionRate || 0.5) + (historyItem.liked ? 0.5 : 0);
      totalWeight += weight;

      for (let i = 0; i < EMBEDDING_DIM; i++) {
        aggregatedEmbedding[i] += videoEmb[i] * weight;
      }
    }

    // Normalize
    if (totalWeight > 0) {
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        aggregatedEmbedding[i] /= totalWeight;
      }
    }

    // Normalize to unit length
    const magnitude = Math.sqrt(aggregatedEmbedding.reduce((sum, val) => sum + val * val, 0));
    const normalizedEmbedding = magnitude > 0
      ? aggregatedEmbedding.map(val => val / magnitude)
      : generateRandomEmbedding();

    // Store the embedding
    await query(
      'UPDATE users SET interest_embedding = $1 WHERE id = $2',
      [toPgVector(normalizedEmbedding), userId]
    );

    logger.debug({ userId, videoCount: videoEmbeddings.size }, 'User interest embedding updated');
    return normalizedEmbedding;
  } catch (error) {
    logger.error({ error: error.message, userId }, 'Failed to generate user embedding');
    throw error;
  }
}

/**
 * Find videos similar to a given embedding using pgvector cosine distance.
 * @param {number[]} embedding - The reference embedding
 * @param {number} limit - Maximum number of results
 * @param {object} options - Additional options
 * @param {number[]} options.excludeVideoIds - Video IDs to exclude
 * @param {number} options.excludeUserId - User whose watched videos to exclude
 * @returns {Promise<Array>} Similar videos with similarity scores
 */
export async function findSimilarVideos(embedding, limit = 10, options = {}) {
  try {
    const { excludeVideoIds = [], excludeUserId = null } = options;

    let queryText;
    let queryParams;

    if (excludeUserId) {
      // Exclude videos already watched by user
      if (excludeVideoIds.length > 0) {
        queryText = `
          SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
                 u.avatar_url as creator_avatar_url,
                 1 - (v.embedding <=> $1) as similarity
          FROM videos v
          JOIN users u ON v.creator_id = u.id
          WHERE v.status = 'active'
            AND v.embedding IS NOT NULL
            AND v.id NOT IN (SELECT video_id FROM watch_history WHERE user_id = $3)
            AND v.id != ALL($4)
          ORDER BY v.embedding <=> $1
          LIMIT $2
        `;
        queryParams = [toPgVector(embedding), limit, excludeUserId, excludeVideoIds];
      } else {
        queryText = `
          SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
                 u.avatar_url as creator_avatar_url,
                 1 - (v.embedding <=> $1) as similarity
          FROM videos v
          JOIN users u ON v.creator_id = u.id
          WHERE v.status = 'active'
            AND v.embedding IS NOT NULL
            AND v.id NOT IN (SELECT video_id FROM watch_history WHERE user_id = $3)
          ORDER BY v.embedding <=> $1
          LIMIT $2
        `;
        queryParams = [toPgVector(embedding), limit, excludeUserId];
      }
    } else {
      // Simple similarity search
      if (excludeVideoIds.length > 0) {
        queryText = `
          SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
                 u.avatar_url as creator_avatar_url,
                 1 - (v.embedding <=> $1) as similarity
          FROM videos v
          JOIN users u ON v.creator_id = u.id
          WHERE v.status = 'active'
            AND v.embedding IS NOT NULL
            AND v.id != ALL($3)
          ORDER BY v.embedding <=> $1
          LIMIT $2
        `;
        queryParams = [toPgVector(embedding), limit, excludeVideoIds];
      } else {
        queryText = `
          SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
                 u.avatar_url as creator_avatar_url,
                 1 - (v.embedding <=> $1) as similarity
          FROM videos v
          JOIN users u ON v.creator_id = u.id
          WHERE v.status = 'active'
            AND v.embedding IS NOT NULL
          ORDER BY v.embedding <=> $1
          LIMIT $2
        `;
        queryParams = [toPgVector(embedding), limit];
      }
    }

    const result = await query(queryText, queryParams);

    logger.debug({ limit, resultCount: result.rows.length }, 'Similar videos found');
    return result.rows.map(row => ({
      ...row,
      similarity: parseFloat(row.similarity) || 0,
      source: 'embedding_similarity',
    }));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to find similar videos');
    throw error;
  }
}

/**
 * Find videos similar to a given video.
 * @param {number} videoId - The reference video ID
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Similar videos
 */
export async function findVideosLikeThis(videoId, limit = 10) {
  try {
    // Get the video's embedding
    const videoResult = await query(
      'SELECT embedding FROM videos WHERE id = $1',
      [videoId]
    );

    if (videoResult.rows.length === 0 || !videoResult.rows[0].embedding) {
      logger.debug({ videoId }, 'Video not found or has no embedding');
      return [];
    }

    const embedding = fromPgVector(videoResult.rows[0].embedding);
    return findSimilarVideos(embedding, limit, { excludeVideoIds: [videoId] });
  } catch (error) {
    logger.error({ error: error.message, videoId }, 'Failed to find similar videos');
    throw error;
  }
}

/**
 * Get personalized video recommendations using user interest embedding.
 * @param {number} userId - The user ID
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Recommended videos
 */
export async function getEmbeddingBasedRecommendations(userId, limit = 10) {
  try {
    // Get user's interest embedding
    const userResult = await query(
      'SELECT interest_embedding FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].interest_embedding) {
      // Generate embedding if missing
      await generateUserEmbedding(userId);
      const updatedUser = await query(
        'SELECT interest_embedding FROM users WHERE id = $1',
        [userId]
      );
      if (!updatedUser.rows[0]?.interest_embedding) {
        logger.debug({ userId }, 'Could not generate user embedding');
        return [];
      }
      const embedding = fromPgVector(updatedUser.rows[0].interest_embedding);
      return findSimilarVideos(embedding, limit, { excludeUserId: userId });
    }

    const embedding = fromPgVector(userResult.rows[0].interest_embedding);
    return findSimilarVideos(embedding, limit, { excludeUserId: userId });
  } catch (error) {
    logger.error({ error: error.message, userId }, 'Failed to get embedding recommendations');
    throw error;
  }
}

export default {
  generateVideoEmbedding,
  generateUserEmbedding,
  findSimilarVideos,
  findVideosLikeThis,
  getEmbeddingBasedRecommendations,
};
