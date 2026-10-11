import bcrypt from 'bcryptjs';
import { query, queryOne, withTransaction } from '../utils/db.js';
import { ApiError } from '../utils/errors.js';
import { enqueueSearchIndex } from './searchIndexer.js';
import type { User, UserSummary, Experience, Education, UserSkill } from '../types/index.js';

/**
 * Column lists for the three ways a member is shown. Email is private: only the
 * member's own record carries it, never a profile, search hit, card or path.
 */
const PUBLIC_USER_COLUMNS = `id, first_name, last_name, headline, summary, location, industry,
  profile_image_url, banner_image_url, connection_count, role, created_at, updated_at`;
const SELF_USER_COLUMNS = `${PUBLIC_USER_COLUMNS}, email`;
const SUMMARY_COLUMNS = `id, first_name, last_name, headline, location, profile_image_url, connection_count`;

/**
 * Profile fields a member may change about themselves. Anything else in a request
 * body (role, email, connection_count, or a crafted key) is ignored. Building SET
 * clauses from raw body keys allowed privilege escalation and SQL injection.
 */
export const EDITABLE_PROFILE_FIELDS = [
  'first_name',
  'last_name',
  'headline',
  'summary',
  'location',
  'industry',
  'profile_image_url',
  'banner_image_url',
] as const;

const EDITABLE_EXPERIENCE_FIELDS = [
  'company_name',
  'title',
  'location',
  'start_date',
  'end_date',
  'description',
  'is_current',
] as const;

/**
 * Builds a parameterized SET clause from an allowlist of column names.
 * Values that are undefined are skipped; null clears the column.
 */
function buildSetClause(
  data: Record<string, unknown>,
  allowed: readonly string[],
  firstParam: number
): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  for (const column of allowed) {
    if (!Object.prototype.hasOwnProperty.call(data, column)) continue;
    const value = data[column];
    if (value === undefined) continue;
    clauses.push(`${column} = $${firstParam + values.length}`);
    values.push(value);
  }
  return { clauses, values };
}

/** Returns rows in the order of `ids` (ANY() returns them in index order). */
function orderByIds<T extends { id: number }>(rows: T[], ids: number[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is T => row !== undefined);
}

/**
 * Creates a new user account with hashed password.
 * The search document is queued in the same transaction, so registration never
 * depends on Elasticsearch being up.
 *
 * @param email - User's email address (must be unique)
 * @param password - Plain text password (will be hashed with bcrypt)
 * @param firstName - User's first name
 * @param lastName - User's last name
 * @param headline - Optional professional headline
 * @returns The newly created user object (without password hash)
 */
export async function createUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string,
  headline?: string
): Promise<User> {
  const passwordHash = await bcrypt.hash(password, 10);
  return withTransaction(async (client) => {
    const result = await client.query<User>(
      `INSERT INTO users (email, password_hash, first_name, last_name, headline)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELF_USER_COLUMNS}`,
      [email, passwordHash, firstName, lastName, headline ?? null]
    );
    const user = result.rows[0];
    await enqueueSearchIndex(client, 'user', user.id);
    return user;
  });
}

/**
 * Authenticates a user by email and password.
 * Compares the provided password against the stored bcrypt hash.
 *
 * @param email - User's email address
 * @param password - Plain text password to verify
 * @returns The user object if credentials are valid, null otherwise
 */
export async function authenticateUser(email: string, password: string): Promise<User | null> {
  const row = await queryOne<User & { password_hash: string }>(
    `SELECT ${SELF_USER_COLUMNS}, password_hash FROM users WHERE email = $1`,
    [email]
  );

  if (!row) return null;

  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) return null;

  const { password_hash: _password_hash, ...user } = row;
  return user;
}

/**
 * Retrieves a member's own record, including their email.
 * Use getPublicProfile for anything shown to other people.
 *
 * @param id - The user's unique identifier
 * @returns The user object if found, null otherwise
 */
export async function getUserById(id: number): Promise<User | null> {
  return queryOne<User>(`SELECT ${SELF_USER_COLUMNS} FROM users WHERE id = $1`, [id]);
}

/**
 * Retrieves the public view of a profile (no email).
 *
 * @param id - The user's unique identifier
 * @returns The public profile, or null if not found
 */
export async function getPublicProfile(id: number): Promise<User | null> {
  return queryOne<User>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [id]);
}

/**
 * Retrieves public profiles for several users in one query, in the order given.
 * Used for connection lists and search results (where order is relevance).
 *
 * @param ids - Array of user IDs to fetch
 * @returns Public user objects in the order of `ids`
 */
export async function getUsersByIds(ids: number[]): Promise<User[]> {
  if (ids.length === 0) return [];
  const rows = await query<User>(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ANY($1::int[])`,
    [ids]
  );
  return orderByIds(rows, ids);
}

/**
 * Retrieves card-sized summaries (name, headline, avatar) in the order given.
 *
 * @param ids - Array of user IDs
 * @returns Summaries in the order of `ids`
 */
export async function getUserSummaries(ids: number[]): Promise<UserSummary[]> {
  if (ids.length === 0) return [];
  const rows = await query<UserSummary>(
    `SELECT ${SUMMARY_COLUMNS} FROM users WHERE id = ANY($1::int[])`,
    [ids]
  );
  return orderByIds(rows, ids);
}

/**
 * Updates the caller's own profile. Only allowlisted fields are written; the change
 * and its search reindex are committed together.
 *
 * @param id - The user's unique identifier
 * @param data - Request body; unknown keys are ignored
 * @returns The updated user object, or null if user not found
 */
export async function updateUser(id: number, data: Record<string, unknown>): Promise<User | null> {
  const { clauses, values } = buildSetClause(data, EDITABLE_PROFILE_FIELDS, 1);
  if (clauses.length === 0) return getUserById(id);

  return withTransaction(async (client) => {
    const result = await client.query<User>(
      `UPDATE users SET ${clauses.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length + 1}
       RETURNING ${SELF_USER_COLUMNS}`,
      [...values, id]
    );
    const user = result.rows[0] ?? null;
    if (user) await enqueueSearchIndex(client, 'user', id);
    return user;
  });
}

/**
 * Adds a work experience entry to a user's profile.
 * Links to a company if company_id is provided for richer display.
 *
 * @param userId - The user's unique identifier
 * @param data - Experience details including company, title, dates, and description
 * @returns The newly created experience record
 */
export async function addExperience(
  userId: number,
  data: {
    company_name: string;
    title: string;
    location?: string;
    start_date: Date;
    end_date?: Date;
    description?: string;
    is_current?: boolean;
    company_id?: number;
  }
): Promise<Experience> {
  if (!data.company_name || !data.title || Number.isNaN(data.start_date?.getTime?.())) {
    throw new ApiError(400, 'invalid_experience', 'company_name, title and a valid start_date are required');
  }
  return withTransaction(async (client) => {
    const result = await client.query<Experience>(
      `INSERT INTO experiences (user_id, company_id, company_name, title, location, start_date, end_date, description, is_current)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        userId,
        data.company_id || null,
        data.company_name,
        data.title,
        data.location || null,
        data.start_date,
        data.end_date || null,
        data.description || null,
        data.is_current || false,
      ]
    );
    // Companies are part of the people-search document.
    await enqueueSearchIndex(client, 'user', userId);
    return result.rows[0];
  });
}

/**
 * Updates an existing work experience entry.
 * Only the owner (userId) can modify their experiences; only allowlisted fields change.
 *
 * @param id - The experience record ID
 * @param userId - The user's ID (for ownership verification)
 * @param data - Request body; unknown keys are ignored
 * @returns The updated experience, or null if not found/unauthorized
 */
export async function updateExperience(
  id: number,
  userId: number,
  data: Record<string, unknown>
): Promise<Experience | null> {
  const { clauses, values } = buildSetClause(data, EDITABLE_EXPERIENCE_FIELDS, 1);
  if (clauses.length === 0) return null;

  return withTransaction(async (client) => {
    const result = await client.query<Experience>(
      `UPDATE experiences SET ${clauses.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length + 1} AND user_id = $${values.length + 2}
       RETURNING *`,
      [...values, id, userId]
    );
    const experience = result.rows[0] ?? null;
    if (experience) await enqueueSearchIndex(client, 'user', userId);
    return experience;
  });
}

/**
 * Deletes a work experience entry from a user's profile.
 * Only the owner can delete their experiences.
 *
 * @param id - The experience record ID
 * @param userId - The user's ID (for ownership verification)
 * @returns True if deleted, false if not found or unauthorized
 */
export async function deleteExperience(id: number, userId: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query(`DELETE FROM experiences WHERE id = $1 AND user_id = $2`, [
      id,
      userId,
    ]);
    if (!result.rowCount) return false;
    await enqueueSearchIndex(client, 'user', userId);
    return true;
  });
}

/**
 * Retrieves all work experiences for a user.
 * Includes company details if linked, ordered by recency.
 *
 * @param userId - The user's unique identifier
 * @returns Array of experience records, current jobs first
 */
export async function getUserExperiences(userId: number): Promise<Experience[]> {
  return query<Experience>(
    `SELECT e.*, c.name as company_display_name, c.logo_url as company_logo
     FROM experiences e
     LEFT JOIN companies c ON e.company_id = c.id
     WHERE e.user_id = $1
     ORDER BY e.is_current DESC, e.end_date DESC NULLS FIRST, e.start_date DESC`,
    [userId]
  );
}

/**
 * Adds an education entry to a user's profile.
 *
 * @param userId - The user's unique identifier
 * @param data - Education details including school, degree, and years
 * @returns The newly created education record
 */
export async function addEducation(
  userId: number,
  data: {
    school_name: string;
    degree?: string;
    field_of_study?: string;
    start_year?: number;
    end_year?: number;
    description?: string;
  }
): Promise<Education> {
  if (!data.school_name) {
    throw new ApiError(400, 'invalid_education', 'school_name is required');
  }
  const edu = await queryOne<Education>(
    `INSERT INTO education (user_id, school_name, degree, field_of_study, start_year, end_year, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      userId,
      data.school_name,
      data.degree || null,
      data.field_of_study || null,
      data.start_year || null,
      data.end_year || null,
      data.description || null,
    ]
  );
  return edu!;
}

/**
 * Retrieves all education entries for a user.
 * Ordered by most recent graduation year first.
 *
 * @param userId - The user's unique identifier
 * @returns Array of education records
 */
export async function getUserEducation(userId: number): Promise<Education[]> {
  return query<Education>(
    `SELECT * FROM education WHERE user_id = $1 ORDER BY end_year DESC NULLS FIRST, start_year DESC`,
    [userId]
  );
}

/**
 * Deletes an education entry from a user's profile.
 *
 * @param id - The education record ID
 * @param userId - The user's ID (for ownership verification)
 * @returns True if deleted, false if not found or unauthorized
 */
export async function deleteEducation(id: number, userId: number): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `DELETE FROM education WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  return rows.length > 0;
}

/**
 * Gets or creates a skill by name, normalizing case for deduplication.
 * Skills are shared across users to enable skill-based matching. A concurrent
 * insert of the same name is absorbed by ON CONFLICT instead of failing.
 *
 * @param name - The skill name to find or create
 * @returns The skill's unique identifier
 */
export async function getOrCreateSkill(name: string): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new ApiError(400, 'invalid_skill', 'Skill name must be 1-100 characters');
  }
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM skills WHERE LOWER(name) = LOWER($1) ORDER BY id LIMIT 1`,
    [trimmed]
  );
  if (existing) return existing.id;

  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO skills (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`,
    [trimmed]
  );
  if (inserted) return inserted.id;

  const raced = await queryOne<{ id: number }>(`SELECT id FROM skills WHERE name = $1`, [trimmed]);
  return raced!.id;
}

/**
 * Adds a skill to a user's profile.
 * Creates the skill if it does not exist. Ignores duplicates.
 *
 * @param userId - The user's unique identifier
 * @param skillName - The name of the skill to add
 */
export async function addUserSkill(userId: number, skillName: string): Promise<void> {
  const skillId = await getOrCreateSkill(skillName);
  await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO user_skills (user_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, skillId]
    );
    if (result.rowCount) await enqueueSearchIndex(client, 'user', userId);
  });
}

/**
 * Removes a skill from a user's profile.
 *
 * @param userId - The user's unique identifier
 * @param skillId - The skill ID to remove
 * @returns True if removed, false if skill was not on profile
 */
export async function removeUserSkill(userId: number, skillId: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `DELETE FROM user_skills WHERE user_id = $1 AND skill_id = $2`,
      [userId, skillId]
    );
    if (!result.rowCount) return false;
    await enqueueSearchIndex(client, 'user', userId);
    return true;
  });
}

/**
 * Retrieves all skills for a user with endorsement counts.
 * Ordered by endorsements (most endorsed first), then alphabetically.
 *
 * @param userId - The user's unique identifier
 * @returns Array of user skills with names and endorsement counts
 */
export async function getUserSkills(userId: number): Promise<UserSkill[]> {
  return query<UserSkill>(
    `SELECT us.*, s.name as skill_name
     FROM user_skills us
     JOIN skills s ON us.skill_id = s.id
     WHERE us.user_id = $1
     ORDER BY us.endorsement_count DESC, s.name`,
    [userId]
  );
}

/**
 * Records one endorsement of a member's skill by a 1st-degree connection.
 * The (endorser, member, skill) primary key makes repeats a no-op, and the counter
 * only moves when a new endorsement row was inserted, in the same transaction.
 *
 * @param endorserId - The member giving the endorsement
 * @param userId - The member whose skill is endorsed
 * @param skillId - The skill to endorse
 * @returns True if this was a new endorsement
 * @throws ApiError 403 when not connected, 404 when the member lacks the skill
 */
export async function endorseSkill(endorserId: number, userId: number, skillId: number): Promise<boolean> {
  const [low, high] = endorserId < userId ? [endorserId, userId] : [userId, endorserId];
  return withTransaction(async (client) => {
    const connected = await client.query(
      `SELECT 1 FROM connections WHERE user_id = $1 AND connected_to = $2`,
      [low, high]
    );
    if (!connected.rowCount) {
      throw new ApiError(403, 'not_connected', 'Only 1st-degree connections can endorse skills');
    }
    const hasSkill = await client.query(
      `SELECT 1 FROM user_skills WHERE user_id = $1 AND skill_id = $2`,
      [userId, skillId]
    );
    if (!hasSkill.rowCount) {
      throw new ApiError(404, 'skill_not_found', 'This member has not listed that skill');
    }
    const inserted = await client.query(
      `INSERT INTO skill_endorsements (endorser_id, user_id, skill_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [endorserId, userId, skillId]
    );
    if (!inserted.rowCount) return false;
    await client.query(
      `UPDATE user_skills SET endorsement_count = endorsement_count + 1
       WHERE user_id = $1 AND skill_id = $2`,
      [userId, skillId]
    );
    return true;
  });
}
