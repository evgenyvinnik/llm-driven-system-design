import { query, transaction } from '../config/database.js';
import { cacheGet, cacheSet, cacheDelete } from '../config/redis.js';
import type { Review, PaginatedResponse, ReviewSubmission } from '../types/index.js';

const CACHE_TTL = 300; // 5 minutes

function mapReviewRow(row: Record<string, unknown>): Review {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    appId: row.app_id as string,
    rating: Number(row.rating),
    title: row.title as string | null,
    body: row.body as string | null,
    helpfulCount: Number(row.helpful_count) || 0,
    notHelpfulCount: Number(row.not_helpful_count) || 0,
    integrityScore: parseFloat(row.integrity_score as string) || 1.0,
    status: row.status as Review['status'],
    developerResponse: row.developer_response as string | null,
    developerResponseAt: row.developer_response_at ? new Date(row.developer_response_at as string) : null,
    appVersion: row.app_version as string | null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    user: row.username ? {
      id: row.user_id as string,
      username: row.username as string,
      displayName: row.display_name as string | null,
      avatarUrl: row.avatar_url as string | null,
    } : undefined,
  };
}

export class ReviewService {
  async getReviewsForApp(
    appId: string,
    options: { page?: number; limit?: number; sortBy?: string } = {}
  ): Promise<PaginatedResponse<Review>> {
    const { page = 1, limit = 20, sortBy = 'recent' } = options;

    const cacheKey = `reviews:${appId}:${page}:${limit}:${sortBy}`;
    const cached = await cacheGet<PaginatedResponse<Review>>(cacheKey);
    if (cached) return cached;

    // Get total count
    const countResult = await query(`
      SELECT COUNT(*) FROM reviews WHERE app_id = $1 AND status = 'published'
    `, [appId]);
    const total = parseInt(countResult.rows[0].count as string, 10);

    // Build order clause
    let orderClause = 'ORDER BY r.created_at DESC';
    if (sortBy === 'helpful') {
      orderClause = 'ORDER BY r.helpful_count DESC, r.created_at DESC';
    } else if (sortBy === 'rating_high') {
      orderClause = 'ORDER BY r.rating DESC, r.created_at DESC';
    } else if (sortBy === 'rating_low') {
      orderClause = 'ORDER BY r.rating ASC, r.created_at DESC';
    }

    const offset = (page - 1) * limit;

    const result = await query(`
      SELECT r.*, u.username, u.display_name, u.avatar_url
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.app_id = $1 AND r.status = 'published'
      ${orderClause}
      LIMIT $2 OFFSET $3
    `, [appId, limit, offset]);

    const reviews = result.rows.map((row) => mapReviewRow(row as Record<string, unknown>));

    const response: PaginatedResponse<Review> = {
      data: reviews,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    await cacheSet(cacheKey, response, CACHE_TTL);
    return response;
  }

  async getRatingSummary(appId: string): Promise<{
    averageRating: number;
    totalRatings: number;
    distribution: Record<number, number>;
  }> {
    const cacheKey = `ratings:${appId}`;
    const cached = await cacheGet<{ averageRating: number; totalRatings: number; distribution: Record<number, number> }>(cacheKey);
    if (cached) return cached;

    const result = await query(`
      SELECT
        AVG(rating)::numeric(3,2) as average,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE rating = 1) as one_star,
        COUNT(*) FILTER (WHERE rating = 2) as two_star,
        COUNT(*) FILTER (WHERE rating = 3) as three_star,
        COUNT(*) FILTER (WHERE rating = 4) as four_star,
        COUNT(*) FILTER (WHERE rating = 5) as five_star
      FROM reviews
      WHERE app_id = $1 AND status = 'published'
    `, [appId]);

    const row = result.rows[0];
    const summary = {
      averageRating: parseFloat(row.average as string) || 0,
      totalRatings: parseInt(row.total as string, 10),
      distribution: {
        1: parseInt(row.one_star as string, 10),
        2: parseInt(row.two_star as string, 10),
        3: parseInt(row.three_star as string, 10),
        4: parseInt(row.four_star as string, 10),
        5: parseInt(row.five_star as string, 10),
      },
    };

    await cacheSet(cacheKey, summary, CACHE_TTL);
    return summary;
  }

  async createReview(userId: string, appId: string, data: ReviewSubmission, appVersion?: string): Promise<Review> {
    // Check if user already reviewed this app
    const existing = await query(`
      SELECT id FROM reviews WHERE user_id = $1 AND app_id = $2
    `, [userId, appId]);

    if (existing.rows.length > 0) {
      throw new Error('You have already reviewed this app');
    }

    // Calculate integrity score
    const integrityScore = await this.calculateIntegrityScore(userId, appId, data);

    // Determine initial status based on integrity score
    const status = integrityScore >= 0.6 ? 'published' : 'pending';

    const result = await transaction(async (client) => {
      // Create review
      const reviewResult = await client.query(`
        INSERT INTO reviews (user_id, app_id, rating, title, body, integrity_score, status, app_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [userId, appId, data.rating, data.title || null, data.body || null, integrityScore, status, appVersion || null]);

      // Update app rating if published
      if (status === 'published') {
        await client.query(`
          UPDATE apps
          SET rating_sum = rating_sum + $1,
              rating_count = rating_count + 1,
              average_rating = (rating_sum + $1) / (rating_count + 1),
              updated_at = NOW()
          WHERE id = $2
        `, [data.rating, appId]);
      }

      return reviewResult.rows[0];
    });

    // Clear caches
    await this.clearReviewCaches(appId);

    return mapReviewRow(result as Record<string, unknown>);
  }

  async updateReview(reviewId: string, userId: string, data: Partial<ReviewSubmission>): Promise<Review | null> {
    // Get existing review
    const existing = await query(`
      SELECT * FROM reviews WHERE id = $1 AND user_id = $2
    `, [reviewId, userId]);

    if (existing.rows.length === 0) {
      return null;
    }

    const oldReview = existing.rows[0];
    const oldRating = Number(oldReview.rating);
    const newRating = data.rating ?? oldRating;
    const appId = oldReview.app_id as string;

    await transaction(async (client) => {
      // Update review
      await client.query(`
        UPDATE reviews
        SET rating = COALESCE($1, rating),
            title = COALESCE($2, title),
            body = COALESCE($3, body),
            updated_at = NOW()
        WHERE id = $4 AND user_id = $5
      `, [data.rating, data.title, data.body, reviewId, userId]);

      // Update app rating if rating changed
      if (data.rating && data.rating !== oldRating) {
        await client.query(`
          UPDATE apps
          SET rating_sum = rating_sum - $1 + $2,
              average_rating = (rating_sum - $1 + $2) / rating_count,
              updated_at = NOW()
          WHERE id = $3
        `, [oldRating, newRating, appId]);
      }
    });

    await this.clearReviewCaches(appId);

    const updated = await query(`
      SELECT r.*, u.username, u.display_name, u.avatar_url
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.id = $1
    `, [reviewId]);

    return mapReviewRow(updated.rows[0] as Record<string, unknown>);
  }

  async deleteReview(reviewId: string, userId: string): Promise<boolean> {
    const existing = await query(`
      SELECT * FROM reviews WHERE id = $1 AND user_id = $2
    `, [reviewId, userId]);

    if (existing.rows.length === 0) {
      return false;
    }

    const review = existing.rows[0];
    const appId = review.app_id as string;
    const rating = Number(review.rating);

    await transaction(async (client) => {
      // Delete review
      await client.query(`DELETE FROM reviews WHERE id = $1`, [reviewId]);

      // Update app rating
      if (review.status === 'published') {
        await client.query(`
          UPDATE apps
          SET rating_sum = GREATEST(rating_sum - $1, 0),
              rating_count = GREATEST(rating_count - 1, 0),
              average_rating = CASE
                WHEN rating_count > 1 THEN (rating_sum - $1) / (rating_count - 1)
                ELSE 0
              END,
              updated_at = NOW()
          WHERE id = $2
        `, [rating, appId]);
      }
    });

    await this.clearReviewCaches(appId);
    return true;
  }

  async voteReview(reviewId: string, userId: string, helpful: boolean): Promise<void> {
    // Check if user already voted
    const existing = await query(`
      SELECT * FROM review_votes WHERE review_id = $1 AND user_id = $2
    `, [reviewId, userId]);

    if (existing.rows.length > 0) {
      const existingVote = existing.rows[0];
      if (existingVote.helpful === helpful) {
        // Remove vote if same
        await query(`DELETE FROM review_votes WHERE id = $1`, [existingVote.id]);
        await query(`
          UPDATE reviews
          SET ${helpful ? 'helpful_count = helpful_count - 1' : 'not_helpful_count = not_helpful_count - 1'}
          WHERE id = $1
        `, [reviewId]);
      } else {
        // Change vote
        await query(`UPDATE review_votes SET helpful = $1 WHERE id = $2`, [helpful, existingVote.id]);
        await query(`
          UPDATE reviews
          SET helpful_count = helpful_count ${helpful ? '+ 1' : '- 1'},
              not_helpful_count = not_helpful_count ${helpful ? '- 1' : '+ 1'}
          WHERE id = $1
        `, [reviewId]);
      }
    } else {
      // Create new vote
      await query(`
        INSERT INTO review_votes (review_id, user_id, helpful)
        VALUES ($1, $2, $3)
      `, [reviewId, userId, helpful]);
      await query(`
        UPDATE reviews
        SET ${helpful ? 'helpful_count = helpful_count + 1' : 'not_helpful_count = not_helpful_count + 1'}
        WHERE id = $1
      `, [reviewId]);
    }
  }

  async addDeveloperResponse(reviewId: string, developerId: string, response: string): Promise<Review | null> {
    // Verify developer owns the app
    const review = await query(`
      SELECT r.*, a.developer_id
      FROM reviews r
      JOIN apps a ON r.app_id = a.id
      WHERE r.id = $1
    `, [reviewId]);

    if (review.rows.length === 0) {
      return null;
    }

    const developerCheck = await query(`
      SELECT id FROM developers WHERE id = $1 AND user_id = $2
    `, [review.rows[0].developer_id, developerId]);

    if (developerCheck.rows.length === 0) {
      throw new Error('Not authorized to respond to this review');
    }

    await query(`
      UPDATE reviews
      SET developer_response = $1, developer_response_at = NOW()
      WHERE id = $2
    `, [response, reviewId]);

    const updated = await query(`
      SELECT r.*, u.username, u.display_name, u.avatar_url
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.id = $1
    `, [reviewId]);

    await this.clearReviewCaches(review.rows[0].app_id);

    return mapReviewRow(updated.rows[0] as Record<string, unknown>);
  }

  // Review integrity scoring
  private async calculateIntegrityScore(userId: string, appId: string, data: ReviewSubmission): Promise<number> {
    const signals: { name: string; score: number; weight: number }[] = [];

    // Check user review velocity
    const userReviews = await query(`
      SELECT created_at FROM reviews
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
    `, [userId]);

    const recentReviewCount = userReviews.rows.length;
    let velocityScore = 1.0;
    if (recentReviewCount > 5) velocityScore = 0.2;
    else if (recentReviewCount > 2) velocityScore = 0.6;
    signals.push({ name: 'review_velocity', score: velocityScore, weight: 0.15 });

    // Content quality
    const contentScore = this.analyzeContent(data.title || '', data.body || '');
    signals.push({ name: 'content_quality', score: contentScore, weight: 0.25 });

    // Account age
    const accountAge = await query(`
      SELECT EXTRACT(DAY FROM NOW() - created_at) as days FROM users WHERE id = $1
    `, [userId]);
    const days = parseFloat(accountAge.rows[0]?.days as string) || 0;
    let ageScore = 1.0;
    if (days < 1) ageScore = 0.3;
    else if (days < 7) ageScore = 0.6;
    else if (days < 30) ageScore = 0.8;
    signals.push({ name: 'account_age', score: ageScore, weight: 0.1 });

    // Verified purchase
    const purchase = await query(`
      SELECT id FROM user_apps WHERE user_id = $1 AND app_id = $2
    `, [userId, appId]);
    const hasPurchase = purchase.rows.length > 0;
    signals.push({ name: 'verified_purchase', score: hasPurchase ? 1.0 : 0.3, weight: 0.2 });

    // Coordination detection (review spike)
    const recentAppReviews = await query(`
      SELECT COUNT(*) FROM reviews
      WHERE app_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
    `, [appId]);
    const avgReviews = await query(`
      SELECT COUNT(*) / GREATEST(EXTRACT(DAY FROM NOW() - MIN(created_at)), 1) as avg
      FROM reviews WHERE app_id = $1
    `, [appId]);

    const recent = parseInt(recentAppReviews.rows[0].count as string, 10);
    const avg = parseFloat(avgReviews.rows[0].avg as string) || 1;
    let coordinationScore = 1.0;
    if (recent > avg * 5) coordinationScore = 0.3;
    signals.push({ name: 'coordination', score: coordinationScore, weight: 0.2 });

    // Originality (simplified check)
    signals.push({ name: 'originality', score: 0.9, weight: 0.1 });

    // Calculate final score
    return signals.reduce((sum, s) => sum + s.score * s.weight, 0);
  }

  private analyzeContent(title: string, body: string): number {
    const text = `${title} ${body}`.toLowerCase();

    // Check for generic phrases
    const genericPhrases = ['great app', 'love it', 'best app ever', 'must download', 'amazing', 'terrible', 'worst app'];
    const hasGeneric = genericPhrases.some((p) => text.includes(p));

    // Check content length
    const lengthScore = Math.min(body.length / 100, 1);

    // Check for specific details
    const hasSpecifics = /\b(feature|update|version|bug|problem|solved|fixed|works|crash|slow|fast)\b/i.test(text);

    return (hasGeneric ? 0.5 : 1.0) * 0.3 + lengthScore * 0.3 + (hasSpecifics ? 1.0 : 0.5) * 0.4;
  }

  private async clearReviewCaches(appId: string): Promise<void> {
    await cacheDelete(`ratings:${appId}`);
    await cacheDelete(`app:${appId}`);
    // Delete all review page caches for this app
    // In production, use cacheDeletePattern
  }
}

export const reviewService = new ReviewService();
