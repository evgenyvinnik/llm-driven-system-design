import { pool, redis, elasticsearch } from '../db/index.js';
import type { User, UserPreferences, Photo, UserProfile, _DiscoveryCard } from '../types/index.js';

/**
 * Service responsible for user account management and profile operations.
 * Handles CRUD operations for users, preferences, photos, and location updates.
 * Maintains data consistency across PostgreSQL, Redis cache, and Elasticsearch.
 */
export class UserService {
  /**
   * Retrieves a user by their unique identifier.
   * @param userId - The UUID of the user to find
   * @returns The user object or null if not found
   */
  async getUserById(userId: string): Promise<User | null> {
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Retrieves a user by their email address.
   * Used during login to verify credentials.
   * @param email - The email address to search for
   * @returns The user object or null if not found
   */
  async getUserByEmail(email: string): Promise<User | null> {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return result.rows[0] || null;
  }

  /**
   * Creates a new user account with default preferences.
   * Also indexes the user in Elasticsearch for discovery.
   * @param userData - Registration data including email, password hash, name, birthdate, gender
   * @returns The newly created user object
   */
  async createUser(userData: {
    email: string;
    password_hash: string;
    name: string;
    birthdate: Date;
    gender: string;
    bio?: string;
  }): Promise<User> {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, birthdate, gender, bio)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userData.email, userData.password_hash, userData.name, userData.birthdate, userData.gender, userData.bio || null]
    );

    const user = result.rows[0];

    // Create default preferences
    await pool.query(
      `INSERT INTO user_preferences (user_id)
       VALUES ($1)`,
      [user.id]
    );

    // Index in Elasticsearch
    await this.indexUserInElasticsearch(user);

    return user;
  }

  /**
   * Updates user profile fields with validation.
   * Only allows modification of safe fields (name, bio, job_title, company, school, location).
   * Re-indexes user in Elasticsearch after update.
   * @param userId - The user's UUID
   * @param updates - Object containing fields to update
   * @returns The updated user object or null if not found
   */
  async updateUser(userId: string, updates: Partial<User>): Promise<User | null> {
    const allowedFields = ['name', 'bio', 'job_title', 'company', 'school', 'latitude', 'longitude'];
    const updateFields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        updateFields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    if (updateFields.length === 0) {
      return this.getUserById(userId);
    }

    values.push(userId);
    const result = await pool.query(
      `UPDATE users SET ${updateFields.join(', ')}, last_active = NOW()
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    const user = result.rows[0];
    if (user) {
      await this.indexUserInElasticsearch(user);
    }

    return user;
  }

  /**
   * Retrieves a user's discovery preferences.
   * @param userId - The user's UUID
   * @returns The preferences object or null if not found
   */
  async getPreferences(userId: string): Promise<UserPreferences | null> {
    const result = await pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Updates discovery preferences for a user.
   * Controls who appears in their swipe deck (gender, age range, distance, visibility).
   * Re-indexes user in Elasticsearch to reflect new preferences.
   * @param userId - The user's UUID
   * @param updates - Partial preferences object with fields to update
   * @returns The updated preferences or null if not found
   */
  async updatePreferences(userId: string, updates: Partial<UserPreferences>): Promise<UserPreferences | null> {
    const allowedFields = ['interested_in', 'age_min', 'age_max', 'distance_km', 'show_me'];
    const updateFields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        updateFields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    if (updateFields.length === 0) {
      return this.getPreferences(userId);
    }

    values.push(userId);
    const result = await pool.query(
      `UPDATE user_preferences SET ${updateFields.join(', ')}
       WHERE user_id = $${paramIndex}
       RETURNING *`,
      values
    );

    // Re-index in Elasticsearch
    const user = await this.getUserById(userId);
    if (user) {
      await this.indexUserInElasticsearch(user, result.rows[0]);
    }

    return result.rows[0];
  }

  /**
   * Retrieves all photos for a user, ordered by position.
   * @param userId - The user's UUID
   * @returns Array of photo objects
   */
  async getPhotos(userId: string): Promise<Photo[]> {
    const result = await pool.query(
      'SELECT * FROM photos WHERE user_id = $1 ORDER BY position',
      [userId]
    );
    return result.rows;
  }

  /**
   * Adds a new photo to a user's profile.
   * First photo added becomes the primary profile photo.
   * @param userId - The user's UUID
   * @param url - URL path to the uploaded photo
   * @param position - Display order position (0-based)
   * @returns The newly created photo object
   */
  async addPhoto(userId: string, url: string, position: number): Promise<Photo> {
    // Check if this should be primary (first photo)
    const existingPhotos = await this.getPhotos(userId);
    const isPrimary = existingPhotos.length === 0;

    const result = await pool.query(
      `INSERT INTO photos (user_id, url, position, is_primary)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, url, position, isPrimary]
    );
    return result.rows[0];
  }

  /**
   * Deletes a photo from a user's profile.
   * Only allows deletion of photos owned by the specified user.
   * @param userId - The user's UUID
   * @param photoId - The photo's UUID
   * @returns True if deleted, false if not found
   */
  async deletePhoto(userId: string, photoId: string): Promise<boolean> {
    const result = await pool.query(
      'DELETE FROM photos WHERE id = $1 AND user_id = $2 RETURNING id',
      [photoId, userId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Retrieves a complete user profile with photos, preferences, and computed age.
   * Aggregates data from multiple tables for full profile display.
   * @param userId - The user's UUID
   * @returns Complete user profile or null if not found
   */
  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const user = await this.getUserById(userId);
    if (!user) return null;

    const [photos, preferences] = await Promise.all([
      this.getPhotos(userId),
      this.getPreferences(userId),
    ]);

    const age = this.calculateAge(user.birthdate);

    return {
      ...user,
      photos,
      preferences,
      age,
    };
  }

  /**
   * Calculates age in years from a birthdate.
   * Accounts for month/day to determine if birthday has occurred this year.
   * @param birthdate - Date of birth
   * @returns Age in whole years
   */
  private calculateAge(birthdate: Date): number {
    const today = new Date();
    const birth = new Date(birthdate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  }

  /**
   * Indexes or updates a user document in Elasticsearch for discovery queries.
   * Includes location for geo queries, preferences for bidirectional matching.
   * Silently handles errors to prevent blocking user operations.
   * @param user - User data to index
   * @param preferences - Optional preferences to include (fetched if not provided)
   */
  private async indexUserInElasticsearch(user: User, preferences?: UserPreferences): Promise<void> {
    try {
      if (!preferences) {
        preferences = await this.getPreferences(user.id) || undefined;
      }

      const doc: Record<string, unknown> = {
        id: user.id,
        name: user.name,
        gender: user.gender,
        age: this.calculateAge(user.birthdate),
        last_active: user.last_active,
        show_me: preferences?.show_me ?? true,
        interested_in: preferences?.interested_in ?? ['male', 'female'],
      };

      if (user.latitude !== null && user.longitude !== null) {
        doc.location = {
          lat: user.latitude,
          lon: user.longitude,
        };
      }

      await elasticsearch.index({
        index: 'users',
        id: user.id,
        document: doc,
      });
    } catch (error) {
      console.error('Error indexing user in Elasticsearch:', error);
    }
  }

  /**
   * Updates the user's last_active timestamp.
   * Called during login and activity to track user engagement.
   * Updates both PostgreSQL and Elasticsearch.
   * @param userId - The user's UUID
   */
  async updateLastActive(userId: string): Promise<void> {
    await pool.query(
      'UPDATE users SET last_active = NOW() WHERE id = $1',
      [userId]
    );

    // Update in Elasticsearch
    try {
      await elasticsearch.update({
        index: 'users',
        id: userId,
        doc: {
          last_active: new Date().toISOString(),
        },
      });
    } catch (_error) {
      // Ignore Elasticsearch errors for activity updates
    }
  }

  /**
   * Updates the user's geographic location for geo-based discovery.
   * Stores in PostgreSQL for persistence, Elasticsearch for queries, and Redis for fast access.
   * @param userId - The user's UUID
   * @param latitude - Latitude coordinate (-90 to 90)
   * @param longitude - Longitude coordinate (-180 to 180)
   */
  async updateLocation(userId: string, latitude: number, longitude: number): Promise<void> {
    await pool.query(
      'UPDATE users SET latitude = $2, longitude = $3, last_active = NOW() WHERE id = $1',
      [userId, latitude, longitude]
    );

    // Update in Elasticsearch
    try {
      await elasticsearch.update({
        index: 'users',
        id: userId,
        doc: {
          location: { lat: latitude, lon: longitude },
          last_active: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('Error updating location in Elasticsearch:', error);
    }

    // Cache location in Redis for quick access
    await redis.set(
      `user:${userId}:location`,
      JSON.stringify({ latitude, longitude }),
      'EX',
      3600
    );
  }

  /**
   * Retrieves a paginated list of all users for admin dashboard.
   * Includes total count for pagination UI.
   * @param limit - Maximum number of users to return (default: 50)
   * @param offset - Number of users to skip (for pagination)
   * @returns Object with users array and total count
   */
  async getAllUsers(limit: number = 50, offset: number = 0): Promise<{ users: User[]; total: number }> {
    const [usersResult, countResult] = await Promise.all([
      pool.query(
        'SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      ),
      pool.query('SELECT COUNT(*) FROM users'),
    ]);

    return {
      users: usersResult.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }
}
