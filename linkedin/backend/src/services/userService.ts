import bcrypt from 'bcryptjs';
import { query, queryOne, execute } from '../utils/db.js';
import { indexUser } from '../utils/elasticsearch.js';
import type { User, Experience, Education, UserSkill } from '../types/index.js';

export async function createUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string,
  headline?: string
): Promise<User> {
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await queryOne<User>(
    `INSERT INTO users (email, password_hash, first_name, last_name, headline)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, first_name, last_name, headline, summary, location, industry,
               profile_image_url, banner_image_url, connection_count, role, created_at, updated_at`,
    [email, passwordHash, firstName, lastName, headline]
  );

  if (user) {
    // Index in Elasticsearch
    await indexUser({
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      headline: user.headline,
    });
  }

  return user!;
}

export async function authenticateUser(email: string, password: string): Promise<User | null> {
  const row = await queryOne<User & { password_hash: string }>(
    `SELECT id, email, password_hash, first_name, last_name, headline, summary, location, industry,
            profile_image_url, banner_image_url, connection_count, role, created_at, updated_at
     FROM users WHERE email = $1`,
    [email]
  );

  if (!row) return null;

  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) return null;

  const { password_hash, ...user } = row;
  return user;
}

export async function getUserById(id: number): Promise<User | null> {
  return queryOne<User>(
    `SELECT id, email, first_name, last_name, headline, summary, location, industry,
            profile_image_url, banner_image_url, connection_count, role, created_at, updated_at
     FROM users WHERE id = $1`,
    [id]
  );
}

export async function getUsersByIds(ids: number[]): Promise<User[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  return query<User>(
    `SELECT id, email, first_name, last_name, headline, summary, location, industry,
            profile_image_url, banner_image_url, connection_count, role, created_at, updated_at
     FROM users WHERE id IN (${placeholders})`,
    ids
  );
}

export async function updateUser(
  id: number,
  data: Partial<{
    first_name: string;
    last_name: string;
    headline: string;
    summary: string;
    location: string;
    industry: string;
    profile_image_url: string;
    banner_image_url: string;
  }>
): Promise<User | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (fields.length === 0) return getUserById(id);

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const user = await queryOne<User>(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex}
     RETURNING id, email, first_name, last_name, headline, summary, location, industry,
               profile_image_url, banner_image_url, connection_count, role, created_at, updated_at`,
    values
  );

  if (user) {
    const skills = await getUserSkills(id);
    const experiences = await getUserExperiences(id);
    await indexUser({
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      headline: user.headline,
      summary: user.summary,
      location: user.location,
      industry: user.industry,
      skills: skills.map(s => s.skill_name || ''),
      companies: experiences.map(e => e.company_name),
    });
  }

  return user;
}

// Experience functions
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
  const exp = await queryOne<Experience>(
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
  return exp!;
}

export async function updateExperience(
  id: number,
  userId: number,
  data: Partial<{
    company_name: string;
    title: string;
    location: string;
    start_date: Date;
    end_date: Date | null;
    description: string;
    is_current: boolean;
  }>
): Promise<Experience | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = NOW()`);
  values.push(id, userId);

  return queryOne<Experience>(
    `UPDATE experiences SET ${fields.join(', ')} WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}
     RETURNING *`,
    values
  );
}

export async function deleteExperience(id: number, userId: number): Promise<boolean> {
  const count = await execute(
    `DELETE FROM experiences WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return count > 0;
}

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

// Education functions
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

export async function getUserEducation(userId: number): Promise<Education[]> {
  return query<Education>(
    `SELECT * FROM education WHERE user_id = $1 ORDER BY end_year DESC NULLS FIRST, start_year DESC`,
    [userId]
  );
}

export async function deleteEducation(id: number, userId: number): Promise<boolean> {
  const count = await execute(
    `DELETE FROM education WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return count > 0;
}

// Skills functions
export async function getOrCreateSkill(name: string): Promise<number> {
  const normalized = name.toLowerCase().trim();
  let skill = await queryOne<{ id: number }>(`SELECT id FROM skills WHERE LOWER(name) = $1`, [normalized]);

  if (!skill) {
    skill = await queryOne<{ id: number }>(
      `INSERT INTO skills (name) VALUES ($1) RETURNING id`,
      [name.trim()]
    );
  }

  return skill!.id;
}

export async function addUserSkill(userId: number, skillName: string): Promise<void> {
  const skillId = await getOrCreateSkill(skillName);
  await execute(
    `INSERT INTO user_skills (user_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, skillId]
  );
}

export async function removeUserSkill(userId: number, skillId: number): Promise<boolean> {
  const count = await execute(
    `DELETE FROM user_skills WHERE user_id = $1 AND skill_id = $2`,
    [userId, skillId]
  );
  return count > 0;
}

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

export async function endorseSkill(userId: number, skillId: number): Promise<void> {
  await execute(
    `UPDATE user_skills SET endorsement_count = endorsement_count + 1 WHERE user_id = $1 AND skill_id = $2`,
    [userId, skillId]
  );
}
