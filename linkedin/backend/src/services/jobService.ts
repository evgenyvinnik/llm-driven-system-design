import { query, queryOne, withTransaction } from '../utils/db.js';
import { isSearchAvailable, searchJobs as esSearchJobs } from '../utils/elasticsearch.js';
import { ApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { searchFallbacksTotal } from '../utils/metrics.js';
import { getFirstDegreeConnections } from './connectionService.js';
import { getUserSkills, getUserExperiences } from './userService.js';
import { enqueueSearchIndex } from './searchIndexer.js';
import { toPrefixQuery, type SearchSource } from './searchService.js';
import type { Job, JobApplication, Company, Skill } from '../types/index.js';

/** Explicit columns: `j.*` would also return the internal search_document tsvector. */
const JOB_COLUMNS = `j.id, j.company_id, j.posted_by_user_id, j.title, j.description, j.location,
  j.is_remote, j.employment_type, j.experience_level, j.years_required, j.salary_min,
  j.salary_max, j.status, j.created_at, j.updated_at`;

/** Optional filters shared by listing, Elasticsearch search and the SQL fallback. */
export interface JobFilters {
  location?: string;
  is_remote?: boolean;
  employment_type?: string;
  experience_level?: string;
}

/**
 * Creates a new company in the system.
 * Companies are central to job postings and user work history.
 *
 * @param data - Company details including name, slug, and optional metadata
 * @returns The newly created company
 */
export async function createCompany(data: {
  name: string;
  slug: string;
  description?: string;
  industry?: string;
  size?: string;
  location?: string;
  website?: string;
  logo_url?: string;
}): Promise<Company> {
  const company = await queryOne<Company>(
    `INSERT INTO companies (name, slug, description, industry, size, location, website, logo_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.name,
      data.slug,
      data.description || null,
      data.industry || null,
      data.size || null,
      data.location || null,
      data.website || null,
      data.logo_url || null,
    ]
  );
  return company!;
}

/**
 * Retrieves a company by its unique ID.
 *
 * @param id - The company's unique identifier
 * @returns The company object or null if not found
 */
export async function getCompanyById(id: number): Promise<Company | null> {
  return queryOne<Company>(`SELECT * FROM companies WHERE id = $1`, [id]);
}

/**
 * Retrieves a company by its URL slug.
 * Slugs are used for SEO-friendly company page URLs.
 *
 * @param slug - The company's unique URL slug
 * @returns The company object or null if not found
 */
export async function getCompanyBySlug(slug: string): Promise<Company | null> {
  return queryOne<Company>(`SELECT * FROM companies WHERE slug = $1`, [slug]);
}

/**
 * Retrieves all companies with pagination.
 * Ordered alphabetically by name.
 *
 * @param offset - Number of companies to skip (default: 0)
 * @param limit - Maximum companies to return (default: 50)
 * @returns Array of company objects
 */
export async function getAllCompanies(offset = 0, limit = 50): Promise<Company[]> {
  return query<Company>(
    `SELECT * FROM companies ORDER BY name OFFSET $1 LIMIT $2`,
    [offset, limit]
  );
}

/**
 * Creates a new job posting.
 * The job, its skills and its search-index entry commit together; the outbox relay
 * pushes the document to Elasticsearch (see searchIndexer).
 *
 * @param data - Job details including company, title, description, requirements, and salary
 * @returns The newly created job
 */
export async function createJob(data: {
  company_id: number;
  posted_by_user_id?: number;
  title: string;
  description: string;
  location?: string;
  is_remote?: boolean;
  employment_type?: string;
  experience_level?: string;
  years_required?: number;
  salary_min?: number;
  salary_max?: number;
  required_skill_ids?: number[];
}): Promise<Job> {
  if (!data.company_id || !data.title || !data.description) {
    throw new ApiError(400, 'invalid_job', 'company_id, title and description are required');
  }
  return withTransaction(async (client) => {
    const company = await client.query('SELECT 1 FROM companies WHERE id = $1', [data.company_id]);
    if (!company.rowCount) throw new ApiError(404, 'company_not_found', 'Company not found');

    const result = await client.query<Job>(
      `INSERT INTO jobs AS j (company_id, posted_by_user_id, title, description, location, is_remote,
                              employment_type, experience_level, years_required, salary_min, salary_max)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${JOB_COLUMNS}`,
      [
        data.company_id,
        data.posted_by_user_id || null,
        data.title,
        data.description,
        data.location || null,
        data.is_remote || false,
        data.employment_type || null,
        data.experience_level || null,
        data.years_required || null,
        data.salary_min || null,
        data.salary_max || null,
      ]
    );
    const job = result.rows[0];

    if (data.required_skill_ids && data.required_skill_ids.length > 0) {
      await client.query(
        `INSERT INTO job_skills (job_id, skill_id, is_required)
         SELECT $1, skill_id, true FROM unnest($2::int[]) AS skill_id
         ON CONFLICT DO NOTHING`,
        [job.id, data.required_skill_ids]
      );
    }

    await enqueueSearchIndex(client, 'job', job.id);
    return job;
  });
}

/**
 * Retrieves a job by ID with company details and required skills.
 *
 * @param id - The job's unique identifier
 * @returns The job with company and skills, or null if not found
 */
export async function getJobById(id: number): Promise<Job | null> {
  const job = await queryOne<Job>(
    `SELECT ${JOB_COLUMNS},
            json_build_object(
              'id', c.id,
              'name', c.name,
              'slug', c.slug,
              'logo_url', c.logo_url,
              'industry', c.industry,
              'size', c.size,
              'location', c.location,
              'description', c.description,
              'website', c.website
            ) as company
     FROM jobs j
     JOIN companies c ON j.company_id = c.id
     WHERE j.id = $1`,
    [id]
  );

  if (job) {
    job.required_skills = await getJobSkills(id);
  }

  return job;
}

/**
 * Retrieves required skills for a job.
 *
 * @param jobId - The job's unique identifier
 * @returns Array of skill objects required for the job
 */
export async function getJobSkills(jobId: number): Promise<Skill[]> {
  return query<Skill>(
    `SELECT s.* FROM skills s
     JOIN job_skills js ON s.id = js.skill_id
     WHERE js.job_id = $1`,
    [jobId]
  );
}

/**
 * Retrieves jobs with optional filters.
 * Supports filtering by company, location, remote status, employment type, and experience level.
 * Only returns active jobs by default.
 *
 * @param filters - Optional filter criteria
 * @param offset - Number of jobs to skip (default: 0)
 * @param limit - Maximum jobs to return (default: 20)
 * @returns Array of jobs with company information
 */
export async function getJobs(
  filters?: {
    company_id?: number;
    location?: string;
    is_remote?: boolean;
    employment_type?: string;
    experience_level?: string;
    status?: string;
  },
  offset = 0,
  limit = 20
): Promise<Job[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters?.company_id) {
    conditions.push(`j.company_id = $${paramIndex++}`);
    params.push(filters.company_id);
  }
  if (filters?.location) {
    conditions.push(`j.location ILIKE $${paramIndex++}`);
    params.push(`%${filters.location}%`);
  }
  if (filters?.is_remote !== undefined) {
    conditions.push(`j.is_remote = $${paramIndex++}`);
    params.push(filters.is_remote);
  }
  if (filters?.employment_type) {
    conditions.push(`j.employment_type = $${paramIndex++}`);
    params.push(filters.employment_type);
  }
  if (filters?.experience_level) {
    conditions.push(`j.experience_level = $${paramIndex++}`);
    params.push(filters.experience_level);
  }

  conditions.push(`j.status = $${paramIndex++}`);
  params.push(filters?.status || 'active');

  params.push(offset, limit);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return query<Job>(
    `SELECT ${JOB_COLUMNS},
            json_build_object(
              'id', c.id,
              'name', c.name,
              'slug', c.slug,
              'logo_url', c.logo_url
            ) as company
     FROM jobs j
     JOIN companies c ON j.company_id = c.id
     ${whereClause}
     ORDER BY j.created_at DESC
     OFFSET $${paramIndex} LIMIT $${paramIndex + 1}`,
    params
  );
}

/**
 * Full-text job search in PostgreSQL (the fallback when Elasticsearch is down).
 * Title words match by prefix, title and description by English stem, and the
 * company name at query time; the same filters as the Elasticsearch path apply.
 */
async function searchJobsInPostgres(
  searchQuery: string,
  filters: JobFilters,
  offset: number,
  limit: number
): Promise<Job[]> {
  const prefix = toPrefixQuery(searchQuery);
  if (!prefix) return [];
  const conditions = [`j.status = 'active'`];
  const params: unknown[] = [prefix, searchQuery];
  if (filters.location) {
    params.push(`%${filters.location}%`);
    conditions.push(`j.location ILIKE $${params.length}`);
  }
  if (filters.is_remote) conditions.push('j.is_remote = true');
  if (filters.employment_type) {
    params.push(filters.employment_type);
    conditions.push(`j.employment_type = $${params.length}`);
  }
  if (filters.experience_level) {
    params.push(filters.experience_level);
    conditions.push(`j.experience_level = $${params.length}`);
  }
  params.push(offset, limit);

  return query<Job>(
    `WITH q AS (
       SELECT to_tsquery('simple', $1) || websearch_to_tsquery('english', $2) AS query
     )
     SELECT ${JOB_COLUMNS},
            json_build_object('id', c.id, 'name', c.name, 'slug', c.slug, 'logo_url', c.logo_url) AS company
     FROM jobs j
     JOIN companies c ON j.company_id = c.id
     CROSS JOIN q
     WHERE ${conditions.join(' AND ')}
       AND (j.search_document @@ q.query OR to_tsvector('simple', c.name) @@ q.query)
     ORDER BY ts_rank(j.search_document, q.query) DESC, j.created_at DESC
     OFFSET $${params.length - 1} LIMIT $${params.length}`,
    params
  );
}

/**
 * Searches for jobs using Elasticsearch with optional filters.
 * Falls back to PostgreSQL full-text search if Elasticsearch is unavailable.
 * Preserves relevance ranking from search results.
 *
 * @param searchQuery - The search query string
 * @param filters - Optional filters for location, remote, type, and level
 * @param offset - Number of results to skip (default: 0)
 * @param limit - Maximum results to return (default: 20)
 * @returns Matching jobs ordered by relevance, and which engine answered
 */
export async function searchJobs(
  searchQuery: string,
  filters: JobFilters = {},
  offset = 0,
  limit = 20
): Promise<{ jobs: Job[]; source: SearchSource }> {
  if (isSearchAvailable()) {
    try {
      const jobIds = await esSearchJobs(searchQuery, filters, limit + offset);
      const paginatedIds = jobIds.slice(offset, offset + limit);
      if (paginatedIds.length === 0) return { jobs: [], source: 'elasticsearch' };

      const jobs = await query<Job>(
        `SELECT ${JOB_COLUMNS},
                json_build_object(
                  'id', c.id,
                  'name', c.name,
                  'slug', c.slug,
                  'logo_url', c.logo_url
                ) as company
         FROM jobs j
         JOIN companies c ON j.company_id = c.id
         WHERE j.id = ANY($1::int[])`,
        [paginatedIds]
      );

      // Preserve search ranking order
      const jobMap = new Map(jobs.map(j => [j.id, j]));
      return {
        jobs: paginatedIds.map(id => jobMap.get(id)).filter((job): job is Job => job !== undefined),
        source: 'elasticsearch',
      };
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'Job search fell back to PostgreSQL');
    }
  }
  searchFallbacksTotal.inc({ type: 'job' });
  return { jobs: await searchJobsInPostgres(searchQuery, filters, offset, limit), source: 'postgres' };
}

/**
 * Calculates a match score between a job and a user.
 * Scoring factors:
 * - Skills match (40% weight) - percentage of required skills the user has
 * - Experience level match (25% weight) - based on years of experience
 * - Location match (15% weight) - remote jobs get full points
 * - Network connection at company (10% weight) - having a 1st-degree connection
 *
 * @param jobId - The job to evaluate
 * @param userId - The user to match
 * @returns Match score from 0-100
 */
export async function calculateJobMatchScore(jobId: number, userId: number): Promise<number> {
  const [job, userSkills, userExperiences] = await Promise.all([
    getJobById(jobId),
    getUserSkills(userId),
    getUserExperiences(userId),
  ]);

  if (!job) return 0;

  let score = 0;
  const userSkillIds = new Set(userSkills.map(s => s.skill_id));
  const requiredSkillIds = job.required_skills?.map(s => s.id) || [];

  // Skills match (40% weight)
  if (requiredSkillIds.length > 0) {
    const matchedSkills = requiredSkillIds.filter(id => userSkillIds.has(id)).length;
    score += (matchedSkills / requiredSkillIds.length) * 40;
  } else {
    score += 20; // No required skills = neutral
  }

  // Experience level match (25% weight)
  const totalExperienceYears = userExperiences.reduce((sum, exp) => {
    const startYear = new Date(exp.start_date).getFullYear();
    const endYear = exp.end_date ? new Date(exp.end_date).getFullYear() : new Date().getFullYear();
    return sum + (endYear - startYear);
  }, 0);

  if (job.years_required) {
    const expDiff = Math.abs(job.years_required - totalExperienceYears);
    score += Math.max(0, 25 - expDiff * 5);
  } else {
    score += 15;
  }

  // Location match (15% weight)
  if (job.is_remote) {
    score += 15;
  }

  // Connection at company (10% weight)
  const connections = await getFirstDegreeConnections(userId);
  if (connections.length > 0) {
    const companyEmployees = await query<{ id: number }>(
      `SELECT DISTINCT user_id as id FROM experiences
       WHERE company_id = $1 AND is_current = true AND user_id = ANY($2::int[])`,
      [job.company_id, connections]
    );
    if (companyEmployees.length > 0) {
      score += 10;
    }
  }

  return Math.round(score);
}

/**
 * Submits a job application for a user.
 * Calculates match score at application time for ranking.
 * Uses upsert to allow re-applying with updated materials.
 *
 * @param jobId - The job to apply for
 * @param userId - The applicant's user ID
 * @param data - Application materials (resume URL and cover letter)
 * @returns The created or updated job application
 */
export async function applyForJob(
  jobId: number,
  userId: number,
  data: {
    resume_url?: string;
    cover_letter?: string;
  }
): Promise<JobApplication> {
  const job = await queryOne<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [jobId]);
  if (!job) throw new ApiError(404, 'job_not_found', 'Job not found');
  if (job.status !== 'active') throw new ApiError(409, 'job_closed', 'This job is no longer accepting applications');

  const matchScore = await calculateJobMatchScore(jobId, userId);

  const application = await queryOne<JobApplication>(
    `INSERT INTO job_applications (job_id, user_id, resume_url, cover_letter, match_score)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id, user_id) DO UPDATE
     SET resume_url = EXCLUDED.resume_url,
         cover_letter = EXCLUDED.cover_letter,
         match_score = EXCLUDED.match_score,
         updated_at = NOW()
     RETURNING *`,
    [jobId, userId, data.resume_url || null, data.cover_letter || null, matchScore]
  );

  return application!;
}

/**
 * Retrieves all job applications for a user.
 * Includes job details and company information.
 *
 * @param userId - The applicant's user ID
 * @returns Array of applications with job details, ordered by recency
 */
export async function getUserApplications(userId: number): Promise<JobApplication[]> {
  return query<JobApplication>(
    `SELECT ja.*,
            json_build_object(
              'id', j.id,
              'title', j.title,
              'location', j.location,
              'company', json_build_object(
                'id', c.id,
                'name', c.name,
                'logo_url', c.logo_url
              )
            ) as job
     FROM job_applications ja
     JOIN jobs j ON ja.job_id = j.id
     JOIN companies c ON j.company_id = c.id
     WHERE ja.user_id = $1
     ORDER BY ja.created_at DESC`,
    [userId]
  );
}

/**
 * Retrieves all applicants for a job.
 * Includes applicant profile information.
 * Ordered by match score descending for easy review.
 *
 * @param jobId - The job's unique identifier
 * @returns Array of applications with applicant details
 */
export async function getJobApplicants(jobId: number): Promise<JobApplication[]> {
  return query<JobApplication>(
    `SELECT ja.*,
            json_build_object(
              'id', u.id,
              'first_name', u.first_name,
              'last_name', u.last_name,
              'headline', u.headline,
              'profile_image_url', u.profile_image_url
            ) as applicant
     FROM job_applications ja
     JOIN users u ON ja.user_id = u.id
     WHERE ja.job_id = $1
     ORDER BY ja.match_score DESC, ja.created_at ASC`,
    [jobId]
  );
}

/**
 * Updates the status of a job application.
 * Used by recruiters to track applicant progress.
 *
 * @param applicationId - The application's unique identifier
 * @param status - The new status (pending, reviewed, accepted, rejected)
 * @returns The updated application, or null if not found
 */
export async function updateApplicationStatus(
  applicationId: number,
  status: 'pending' | 'reviewed' | 'accepted' | 'rejected'
): Promise<JobApplication | null> {
  return queryOne<JobApplication>(
    `UPDATE job_applications SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [applicationId, status]
  );
}

/**
 * Generates job recommendations for a user.
 * Matches jobs based on the user's skills and excludes already-applied jobs.
 * Ranked by skill match count.
 *
 * @param userId - The user to generate recommendations for
 * @param limit - Maximum recommendations to return (default: 10)
 * @returns Array of recommended jobs with match information
 */
export async function getRecommendedJobs(userId: number, limit = 10): Promise<Job[]> {
  const [userSkills, userExperiences] = await Promise.all([
    getUserSkills(userId),
    getUserExperiences(userId),
  ]);

  const skillIds = userSkills.map(s => s.skill_id);
  const _industries = [...new Set(userExperiences.map(e => e.company_name))];

  // Get jobs that match user's skills
  const jobs = await query<Job & { match_score: number }>(
    // No SELECT DISTINCT here: Postgres has no equality operator for `json`, so
    // DISTINCT over a row containing json_build_object(...) fails outright with
    // "could not identify an equality operator for type json". De-duplicate with
    // EXISTS on job_skills instead of a LEFT JOIN that multiplies rows — that
    // removes the need for DISTINCT altogether (and is cheaper).
    `SELECT ${JOB_COLUMNS},
            json_build_object(
              'id', c.id,
              'name', c.name,
              'slug', c.slug,
              'logo_url', c.logo_url
            ) as company,
            (
              SELECT COUNT(*) FROM job_skills js
              WHERE js.job_id = j.id AND js.skill_id = ANY($1::int[])
            ) * 10 as match_score
     FROM jobs j
     JOIN companies c ON j.company_id = c.id
     WHERE j.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM job_applications WHERE job_id = j.id AND user_id = $2)
       AND (
         array_length($1::int[], 1) IS NULL
         OR EXISTS (
           SELECT 1 FROM job_skills js
           WHERE js.job_id = j.id AND js.skill_id = ANY($1::int[])
         )
       )
     ORDER BY match_score DESC, j.created_at DESC
     LIMIT $3`,
    [skillIds, userId, limit]
  );

  return jobs;
}
