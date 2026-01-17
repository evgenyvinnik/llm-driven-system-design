import { Client } from '@elastic/elasticsearch';

const elasticConfig = {
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
};

export const esClient = new Client(elasticConfig);

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
