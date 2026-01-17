import { pool, redis, elasticsearch } from '../db/index.js';
import type { DiscoveryCard, Photo } from '../types/index.js';
import { UserService } from './userService.js';

export class DiscoveryService {
  private userService: UserService;

  constructor() {
    this.userService = new UserService();
  }

  // Get discovery deck for a user
  async getDiscoveryDeck(userId: string, limit: number = 20): Promise<DiscoveryCard[]> {
    const user = await this.userService.getUserById(userId);
    if (!user || user.latitude === null || user.longitude === null) {
      return [];
    }

    const preferences = await this.userService.getPreferences(userId);
    if (!preferences) {
      return [];
    }

    // Get already swiped users from Redis
    const seenUsers = await this.getSeenUsers(userId);

    // Get candidates from Elasticsearch
    const candidates = await this.geoCandidateSearch(
      user.latitude,
      user.longitude,
      preferences.distance_km,
      preferences.interested_in,
      preferences.age_min,
      preferences.age_max,
      user.gender,
      seenUsers,
      limit * 3 // Fetch extra for filtering and ranking
    );

    // Filter out already swiped
    const filteredCandidates = candidates.filter((c) => !seenUsers.has(c.id));

    // Score and rank candidates
    const rankedCandidates = await this.rankCandidates(userId, user, filteredCandidates);

    // Take top N
    const deck = rankedCandidates.slice(0, limit);

    // Load photos for each candidate
    const deckWithPhotos = await Promise.all(
      deck.map(async (candidate) => {
        const photos = await this.userService.getPhotos(candidate.id);
        return {
          ...candidate,
          photos,
        };
      })
    );

    return deckWithPhotos;
  }

  // Elasticsearch geo search for candidates
  private async geoCandidateSearch(
    latitude: number,
    longitude: number,
    radiusKm: number,
    interestedIn: string[],
    ageMin: number,
    ageMax: number,
    userGender: string,
    excludeIds: Set<string>,
    limit: number
  ): Promise<DiscoveryCard[]> {
    try {
      const mustClauses: Record<string, unknown>[] = [
        { terms: { gender: interestedIn } },
        { range: { age: { gte: ageMin, lte: ageMax } } },
        { term: { show_me: true } },
        { range: { last_active: { gte: 'now-7d' } } },
        // Bidirectional matching: they should be interested in my gender
        { terms: { interested_in: [userGender] } },
      ];

      const mustNotClauses: Record<string, unknown>[] = [];
      if (excludeIds.size > 0) {
        mustNotClauses.push({ ids: { values: Array.from(excludeIds) } });
      }

      const query: Record<string, unknown> = {
        bool: {
          must: mustClauses,
          must_not: mustNotClauses,
          filter: {
            geo_distance: {
              distance: `${radiusKm}km`,
              location: {
                lat: latitude,
                lon: longitude,
              },
            },
          },
        },
      };

      const result = await elasticsearch.search({
        index: 'users',
        body: {
          query,
          sort: [
            {
              _geo_distance: {
                location: { lat: latitude, lon: longitude },
                order: 'asc',
                unit: 'km',
              },
            },
            { last_active: { order: 'desc' } },
          ],
          size: limit,
        },
      });

      const hits = result.hits.hits;
      return hits.map((hit: any) => {
        const source = hit._source;
        const distance = hit.sort?.[0] as number || 0;
        return {
          id: source.id,
          name: source.name,
          age: source.age,
          bio: null,
          job_title: null,
          company: null,
          school: null,
          distance: this.formatDistance(distance),
          photos: [],
        };
      });
    } catch (error) {
      console.error('Elasticsearch search error:', error);
      // Fallback to PostgreSQL
      return this.postgresFallbackSearch(
        latitude,
        longitude,
        radiusKm,
        interestedIn,
        ageMin,
        ageMax,
        userGender,
        excludeIds,
        limit
      );
    }
  }

  // PostgreSQL fallback when Elasticsearch is unavailable
  private async postgresFallbackSearch(
    latitude: number,
    longitude: number,
    radiusKm: number,
    interestedIn: string[],
    ageMin: number,
    ageMax: number,
    userGender: string,
    excludeIds: Set<string>,
    limit: number
  ): Promise<DiscoveryCard[]> {
    const excludeArray = Array.from(excludeIds);
    const excludeClause = excludeArray.length > 0 ? 'AND u.id != ALL($8)' : '';

    const result = await pool.query(
      `SELECT
        u.id, u.name, u.bio, u.job_title, u.company, u.school,
        calculate_age(u.birthdate) as age,
        ST_Distance(u.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000 as distance_km
      FROM users u
      LEFT JOIN user_preferences p ON u.id = p.user_id
      WHERE u.gender = ANY($3)
        AND calculate_age(u.birthdate) BETWEEN $4 AND $5
        AND p.show_me = true
        AND $6 = ANY(p.interested_in)
        AND ST_DWithin(u.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $7 * 1000)
        ${excludeClause}
      ORDER BY distance_km ASC, u.last_active DESC
      LIMIT $9`,
      [
        latitude,
        longitude,
        interestedIn,
        ageMin,
        ageMax,
        userGender,
        radiusKm,
        ...(excludeArray.length > 0 ? [excludeArray] : []),
        limit,
      ]
    );

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      age: row.age,
      bio: row.bio,
      job_title: row.job_title,
      company: row.company,
      school: row.school,
      distance: this.formatDistance(row.distance_km),
      photos: [],
    }));
  }

  // Get set of users already swiped on
  private async getSeenUsers(userId: string): Promise<Set<string>> {
    // Try Redis first
    const liked = await redis.smembers(`swipes:${userId}:liked`);
    const passed = await redis.smembers(`swipes:${userId}:passed`);

    if (liked.length > 0 || passed.length > 0) {
      return new Set([...liked, ...passed, userId]);
    }

    // Fallback to database
    const result = await pool.query(
      'SELECT swiped_id FROM swipes WHERE swiper_id = $1',
      [userId]
    );

    const seen = new Set<string>(result.rows.map((row) => row.swiped_id));
    seen.add(userId);

    // Cache in Redis
    if (result.rows.length > 0) {
      const likes = result.rows.filter((r) => r.direction === 'like').map((r) => r.swiped_id);
      const passes = result.rows.filter((r) => r.direction === 'pass').map((r) => r.swiped_id);

      if (likes.length > 0) {
        await redis.sadd(`swipes:${userId}:liked`, ...likes);
        await redis.expire(`swipes:${userId}:liked`, 86400);
      }
      if (passes.length > 0) {
        await redis.sadd(`swipes:${userId}:passed`, ...passes);
        await redis.expire(`swipes:${userId}:passed`, 86400);
      }
    }

    return seen;
  }

  // Rank candidates by multiple factors
  private async rankCandidates(
    userId: string,
    user: any,
    candidates: DiscoveryCard[]
  ): Promise<DiscoveryCard[]> {
    const scored: Array<{ candidate: DiscoveryCard; score: number }> = [];

    // Check who liked us (in batch)
    const whoLikedUs = await this.getWhoLikedUser(userId);

    for (const candidate of candidates) {
      let score = 0;

      // Factor 1: They liked us (potential match) - big boost
      if (whoLikedUs.has(candidate.id)) {
        score += 200;
      }

      // Factor 2: Profile completeness
      const completeness = this.calculateProfileCompleteness(candidate);
      score += completeness * 30;

      scored.push({ candidate, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.map((s) => ({ ...s.candidate, score: s.score }));
  }

  // Get users who have liked this user
  private async getWhoLikedUser(userId: string): Promise<Set<string>> {
    // Check Redis
    const cached = await redis.smembers(`likes:received:${userId}`);
    if (cached.length > 0) {
      return new Set(cached);
    }

    // Fallback to database
    const result = await pool.query(
      `SELECT swiper_id FROM swipes
       WHERE swiped_id = $1 AND direction = 'like'`,
      [userId]
    );

    const likers = new Set<string>(result.rows.map((row) => row.swiper_id));

    // Cache in Redis
    if (likers.size > 0) {
      await redis.sadd(`likes:received:${userId}`, ...Array.from(likers));
      await redis.expire(`likes:received:${userId}`, 86400);
    }

    return likers;
  }

  // Calculate profile completeness
  private calculateProfileCompleteness(candidate: DiscoveryCard): number {
    let score = 0;
    const fields = ['bio', 'job_title', 'company', 'school'];
    for (const field of fields) {
      if ((candidate as any)[field]) {
        score += 0.25;
      }
    }
    return score;
  }

  // Format distance for display
  private formatDistance(distanceKm: number): string {
    const distanceMiles = distanceKm * 0.621371;
    if (distanceMiles < 1) {
      return 'Less than a mile away';
    } else if (distanceMiles < 5) {
      return `${Math.round(distanceMiles)} miles away`;
    } else {
      return `${Math.round(distanceMiles / 5) * 5} miles away`;
    }
  }

  // Get detailed profile for a specific user
  async getProfileCard(userId: string, viewerId: string): Promise<DiscoveryCard | null> {
    const result = await pool.query(
      `SELECT
        u.id, u.name, u.bio, u.job_title, u.company, u.school,
        calculate_age(u.birthdate) as age,
        u.latitude, u.longitude
      FROM users u
      WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) return null;

    const user = result.rows[0];
    const photos = await this.userService.getPhotos(userId);

    // Calculate distance if viewer has location
    const viewer = await this.userService.getUserById(viewerId);
    let distance = 'Unknown distance';
    if (viewer?.latitude && viewer?.longitude && user.latitude && user.longitude) {
      const distResult = await pool.query(
        `SELECT ST_Distance(
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
        ) / 1000 as distance_km`,
        [user.longitude, user.latitude, viewer.longitude, viewer.latitude]
      );
      distance = this.formatDistance(distResult.rows[0].distance_km);
    }

    return {
      id: user.id,
      name: user.name,
      age: user.age,
      bio: user.bio,
      job_title: user.job_title,
      company: user.company,
      school: user.school,
      distance,
      photos,
    };
  }
}
