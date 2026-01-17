import { Client } from '@elastic/elasticsearch';

/**
 * Elasticsearch client configuration.
 * Elasticsearch powers full-text search for users and jobs with fuzzy matching.
 */
const elasticConfig = {
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
};

/**
 * Elasticsearch client singleton for search operations.
 * Provides full-text search with relevance ranking for user and job discovery.
 */
export const esClient = new Client(elasticConfig);

/**
 * Initializes Elasticsearch indices for users and jobs if they do not exist.
 * Creates optimized mappings for text search with appropriate analyzers.
 * Called once at server startup to ensure search infrastructure is ready.
 */
export async function initializeElasticsearch(): Promise<void> {
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
      console.log('Created users index');
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
      console.log('Created jobs index');
    }

    console.log('Elasticsearch initialized');
  } catch (error) {
    console.error('Error initializing Elasticsearch:', error);
  }
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
  await esClient.index({
    index: 'users',
    id: String(user.id),
    document: user,
  });
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
  await esClient.index({
    index: 'jobs',
    id: String(job.id),
    document: job,
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
  const result = await esClient.search({
    index: 'users',
    query: {
      multi_match: {
        query,
        fields: ['first_name^2', 'last_name^2', 'headline', 'summary', 'skills', 'companies'],
        fuzziness: 'AUTO',
      },
    },
    size: limit,
  });

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
  const must: unknown[] = [
    {
      multi_match: {
        query,
        fields: ['title^3', 'description', 'company_name', 'skills^2'],
        fuzziness: 'AUTO',
      },
    },
  ];

  const filter: unknown[] = [{ term: { status: 'active' } }];

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

  const result = await esClient.search({
    index: 'jobs',
    query: {
      bool: {
        must,
        filter,
      },
    },
    size: limit,
  });

  return result.hits.hits.map((hit) => parseInt(hit._id!));
}
