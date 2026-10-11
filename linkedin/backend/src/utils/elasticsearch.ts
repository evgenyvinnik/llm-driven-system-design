import { Client, errors } from '@elastic/elasticsearch';
import { logger } from './logger.js';

// Using type alias for Elasticsearch query container
type EsQueryContainer = { [key: string]: unknown };

/**
 * Elasticsearch client configuration.
 * Elasticsearch powers full-text search for users and jobs with fuzzy matching.
 * Short timeouts and a single retry keep a dead cluster from stalling requests;
 * callers fall back to PostgreSQL full-text search instead.
 */
const elasticConfig = {
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
  requestTimeout: parseInt(process.env.ELASTICSEARCH_TIMEOUT_MS || '3000'),
  maxRetries: 1,
};

/**
 * Elasticsearch client singleton for search operations.
 * Provides full-text search with relevance ranking for user and job discovery.
 */
export const esClient = new Client(elasticConfig);

/** How long to stop calling Elasticsearch after it fails to answer. */
const UNAVAILABLE_COOLDOWN_MS = 30_000;
let unavailableUntil = 0;

/**
 * Thrown instead of calling Elasticsearch while it is marked unavailable.
 */
export class SearchUnavailableError extends Error {
  constructor() {
    super('Elasticsearch is unavailable');
    this.name = 'SearchUnavailableError';
  }
}

/**
 * Whether Elasticsearch should be tried right now. After a connection failure,
 * timeout or 5xx, calls are skipped for 30 seconds (a minimal circuit breaker)
 * so searches fall back immediately instead of waiting on timeouts.
 *
 * @returns True when the cluster is believed reachable
 */
export function isSearchAvailable(): boolean {
  return Date.now() >= unavailableUntil;
}

function recordFailure(error: unknown): void {
  const unreachable =
    error instanceof errors.ConnectionError ||
    error instanceof errors.TimeoutError ||
    error instanceof errors.NoLivingConnectionsError ||
    (error instanceof errors.ResponseError && (error.statusCode ?? 0) >= 500);
  if (unreachable && isSearchAvailable()) {
    unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
    logger.warn({ cooldownMs: UNAVAILABLE_COOLDOWN_MS }, 'Elasticsearch unreachable; pausing calls');
  }
}

/** Runs an Elasticsearch call through the availability guard. */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  if (!isSearchAvailable()) throw new SearchUnavailableError();
  try {
    return await call();
  } catch (error) {
    recordFailure(error);
    throw error;
  }
}

/**
 * Initializes Elasticsearch indices for users and jobs if they do not exist.
 * Creates optimized mappings for text search with appropriate analyzers.
 * Called once at server startup to ensure search infrastructure is ready.
 */
export async function initializeElasticsearch(): Promise<string[]> {
  const created: string[] = [];
  try {
    // Create users index
    const usersIndexExists = await esClient.indices.exists({ index: 'users' });
    if (!usersIndexExists) {
      await esClient.indices.create({
        index: 'users',
        body: {
          mappings: {
            properties: {
              id: { type: 'integer' },
              first_name: { type: 'text' },
              last_name: { type: 'text' },
              headline: { type: 'text' },
              summary: { type: 'text' },
              location: { type: 'keyword' },
              industry: { type: 'keyword' },
              skills: { type: 'keyword' },
              companies: { type: 'text' },
            },
          },
        },
      });
      created.push('users');
      logger.info('Created users index');
    }

    // Create jobs index
    const jobsIndexExists = await esClient.indices.exists({ index: 'jobs' });
    if (!jobsIndexExists) {
      await esClient.indices.create({
        index: 'jobs',
        body: {
          mappings: {
            properties: {
              id: { type: 'integer' },
              title: { type: 'text' },
              description: { type: 'text' },
              company_name: { type: 'text' },
              location: { type: 'keyword' },
              is_remote: { type: 'boolean' },
              employment_type: { type: 'keyword' },
              experience_level: { type: 'keyword' },
              skills: { type: 'keyword' },
              status: { type: 'keyword' },
            },
          },
        },
      });
      created.push('jobs');
      logger.info('Created jobs index');
    }
  } catch (error) {
    recordFailure(error);
    logger.warn({ error: (error as Error).message }, 'Elasticsearch not reachable at startup; search will use PostgreSQL');
  }
  return created;
}

/**
 * Indexes a user document for search.
 * Called when users register or update their profiles to keep search data fresh.
 * Fields are weighted by importance for relevance scoring.
 *
 * @param user - User data to index including name, headline, skills, and companies
 */
export async function indexUser(user: {
  id: number;
  first_name: string;
  last_name: string;
  headline?: string;
  summary?: string;
  location?: string;
  industry?: string;
  skills?: string[];
  companies?: string[];
}): Promise<void> {
  await guarded(() =>
    esClient.index({
      index: 'users',
      id: String(user.id),
      document: user,
    })
  );
}

/**
 * Indexes a job document for search.
 * Called when jobs are created or updated to enable job discovery.
 * Includes company info and skills for comprehensive matching.
 *
 * @param job - Job data to index including title, description, and required skills
 */
export async function indexJob(job: {
  id: number;
  title: string;
  description: string;
  company_name: string;
  location?: string;
  is_remote: boolean;
  employment_type?: string;
  experience_level?: string;
  skills?: string[];
  status: string;
}): Promise<void> {
  await guarded(() =>
    esClient.index({
      index: 'jobs',
      id: String(job.id),
      document: job,
    })
  );
}

/**
 * Removes a document whose source row no longer exists. A missing document is fine.
 *
 * @param index - 'users' or 'jobs'
 * @param id - Document id (the row id)
 */
export async function deleteSearchDocument(index: 'users' | 'jobs', id: number): Promise<void> {
  await guarded(async () => {
    try {
      await esClient.delete({ index, id: String(id) });
    } catch (error) {
      if (error instanceof errors.ResponseError && error.statusCode === 404) return;
      throw error;
    }
  });
}

/**
 * Searches for users matching a query string.
 * Uses multi-match across name, headline, summary, skills, and companies.
 * Names are boosted 2x for higher relevance in people search.
 *
 * @param query - The search query string
 * @param limit - Maximum number of results to return (default: 20)
 * @returns Array of matching user IDs, ordered by relevance
 */
export async function searchUsers(query: string, limit = 20): Promise<number[]> {
  const result = await guarded(() =>
    esClient.search({
      index: 'users',
      query: {
        multi_match: {
          query,
          fields: ['first_name^2', 'last_name^2', 'headline', 'summary', 'skills', 'companies'],
          fuzziness: 'AUTO',
        },
      },
      size: limit,
    })
  );

  return result.hits.hits.map((hit) => parseInt(hit._id!));
}

/**
 * Searches for jobs matching a query string with optional filters.
 * Uses multi-match across title, description, company, and skills.
 * Job title is boosted 3x, skills 2x for relevance in job search.
 * Only returns active jobs by default.
 *
 * @param query - The search query string
 * @param filters - Optional filters for location, remote, employment type, and experience level
 * @param limit - Maximum number of results to return (default: 20)
 * @returns Array of matching job IDs, ordered by relevance
 */
export async function searchJobs(
  query: string,
  filters?: {
    location?: string;
    is_remote?: boolean;
    employment_type?: string;
    experience_level?: string;
  },
  limit = 20
): Promise<number[]> {
  const must: EsQueryContainer[] = [
    {
      multi_match: {
        query,
        fields: ['title^3', 'description', 'company_name', 'skills^2'],
        fuzziness: 'AUTO',
      },
    },
  ];

  const filter: EsQueryContainer[] = [{ term: { status: 'active' } }];

  if (filters?.location) {
    filter.push({ term: { location: filters.location } });
  }
  if (filters?.is_remote !== undefined) {
    filter.push({ term: { is_remote: filters.is_remote } });
  }
  if (filters?.employment_type) {
    filter.push({ term: { employment_type: filters.employment_type } });
  }
  if (filters?.experience_level) {
    filter.push({ term: { experience_level: filters.experience_level } });
  }

  const result = await guarded(() =>
    esClient.search({
      index: 'jobs',
      query: {
        bool: {
          must,
          filter,
        },
      },
      size: limit,
    })
  );

  return result.hits.hits.map((hit) => parseInt(hit._id!));
}
