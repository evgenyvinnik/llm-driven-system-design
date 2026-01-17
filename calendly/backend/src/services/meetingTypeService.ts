import { pool, redis } from '../db/index.js';
import {
  type MeetingType,
  type CreateMeetingTypeInput,
  type UpdateMeetingTypeInput,
} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export class MeetingTypeService {
  /**
   * Create a new meeting type
   */
  async create(userId: string, input: CreateMeetingTypeInput): Promise<MeetingType> {
    const id = uuidv4();

    const result = await pool.query(
      `INSERT INTO meeting_types
       (id, user_id, name, slug, description, duration_minutes,
        buffer_before_minutes, buffer_after_minutes, max_bookings_per_day, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id,
        userId,
        input.name,
        input.slug,
        input.description || null,
        input.duration_minutes,
        input.buffer_before_minutes,
        input.buffer_after_minutes,
        input.max_bookings_per_day || null,
        input.color,
      ]
    );

    // Invalidate cache
    await redis.del(`meeting_types:${userId}`);

    return result.rows[0];
  }

  /**
   * Get meeting type by ID
   */
  async findById(id: string): Promise<MeetingType | null> {
    const cacheKey = `meeting_type:${id}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const result = await pool.query(
      `SELECT * FROM meeting_types WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const meetingType = result.rows[0];
    await redis.setex(cacheKey, 3600, JSON.stringify(meetingType));

    return meetingType;
  }

  /**
   * Get meeting type by user ID and slug
   */
  async findBySlug(userId: string, slug: string): Promise<MeetingType | null> {
    const result = await pool.query(
      `SELECT * FROM meeting_types WHERE user_id = $1 AND slug = $2`,
      [userId, slug]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Get all meeting types for a user
   */
  async findByUserId(userId: string, activeOnly: boolean = false): Promise<MeetingType[]> {
    const cacheKey = `meeting_types:${userId}:${activeOnly}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    let query = `SELECT * FROM meeting_types WHERE user_id = $1`;
    if (activeOnly) {
      query += ` AND is_active = true`;
    }
    query += ` ORDER BY created_at ASC`;

    const result = await pool.query(query, [userId]);

    await redis.setex(cacheKey, 300, JSON.stringify(result.rows));

    return result.rows;
  }

  /**
   * Update a meeting type
   */
  async update(
    id: string,
    userId: string,
    updates: UpdateMeetingTypeInput
  ): Promise<MeetingType | null> {
    const fields: string[] = [];
    const values: (string | number | boolean | null)[] = [];
    let paramIndex = 1;

    const allowedFields = [
      'name',
      'slug',
      'description',
      'duration_minutes',
      'buffer_before_minutes',
      'buffer_after_minutes',
      'max_bookings_per_day',
      'color',
      'is_active',
    ];

    for (const field of allowedFields) {
      const value = updates[field as keyof UpdateMeetingTypeInput];
      if (value !== undefined) {
        fields.push(`${field} = $${paramIndex++}`);
        values.push(value as string | number | boolean | null);
      }
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push(`updated_at = NOW()`);
    values.push(id, userId);

    const result = await pool.query(
      `UPDATE meeting_types SET ${fields.join(', ')}
       WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Invalidate caches
    await redis.del(`meeting_type:${id}`);
    await redis.del(`meeting_types:${userId}:true`);
    await redis.del(`meeting_types:${userId}:false`);

    return result.rows[0];
  }

  /**
   * Delete a meeting type
   */
  async delete(id: string, userId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM meeting_types WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (result.rowCount && result.rowCount > 0) {
      await redis.del(`meeting_type:${id}`);
      await redis.del(`meeting_types:${userId}:true`);
      await redis.del(`meeting_types:${userId}:false`);
      return true;
    }

    return false;
  }

  /**
   * Get meeting type with user info (for public booking page)
   */
  async findByIdWithUser(id: string): Promise<(MeetingType & { user_name: string; user_email: string; user_timezone: string }) | null> {
    const result = await pool.query(
      `SELECT mt.*, u.name as user_name, u.email as user_email, u.time_zone as user_timezone
       FROM meeting_types mt
       JOIN users u ON mt.user_id = u.id
       WHERE mt.id = $1 AND mt.is_active = true`,
      [id]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }
}

export const meetingTypeService = new MeetingTypeService();
