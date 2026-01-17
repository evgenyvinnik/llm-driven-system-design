import { pool, redis, elasticsearch } from '../db/index.js';
import type { User, UserPreferences, Photo, UserProfile, DiscoveryCard } from '../types/index.js';

export class UserService {
  // Get user by ID
  async getUserById(userId: string): Promise<User | null> {
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  // Get user by email
  async getUserByEmail(email: string): Promise<User | null> {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return result.rows[0] || null;
  }

  // Create new user
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

  // Update user profile
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

  // Get user preferences
  async getPreferences(userId: string): Promise<UserPreferences | null> {
    const result = await pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  // Update user preferences
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

  // Get user photos
  async getPhotos(userId: string): Promise<Photo[]> {
    const result = await pool.query(
      'SELECT * FROM photos WHERE user_id = $1 ORDER BY position',
      [userId]
    );
    return result.rows;
  }

  // Add photo
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

  // Delete photo
  async deletePhoto(userId: string, photoId: string): Promise<boolean> {
    const result = await pool.query(
      'DELETE FROM photos WHERE id = $1 AND user_id = $2 RETURNING id',
      [photoId, userId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Get full user profile
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

  // Calculate age from birthdate
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

  // Index user in Elasticsearch
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

  // Update last active timestamp
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
    } catch (error) {
      // Ignore Elasticsearch errors for activity updates
    }
  }

  // Update user location
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

  // Get all users (admin)
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
