import { Client } from '@elastic/elasticsearch';

export const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
});

// Initialize Elasticsearch indexes
export async function initElasticsearch(): Promise<void> {
  const articlesIndexExists = await esClient.indices.exists({ index: 'articles' });

  if (!articlesIndexExists) {
    await esClient.indices.create({
      index: 'articles',
      body: {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          analysis: {
            analyzer: {
              english_analyzer: {
                type: 'standard',
                stopwords: '_english_',
              },
            },
          },
        },
        mappings: {
          properties: {
            title: { type: 'text', analyzer: 'english_analyzer' },
            summary: { type: 'text', analyzer: 'english_analyzer' },
            body: { type: 'text', analyzer: 'english_analyzer' },
            topics: { type: 'keyword' },
            entities: {
              type: 'nested',
              properties: {
                name: { type: 'keyword' },
                type: { type: 'keyword' },
              },
            },
            published_at: { type: 'date' },
            source_id: { type: 'keyword' },
            story_id: { type: 'keyword' },
            fingerprint: { type: 'long' },
          },
        },
      },
    });
    console.log('Created articles index in Elasticsearch');
  }

  const storiesIndexExists = await esClient.indices.exists({ index: 'stories' });

  if (!storiesIndexExists) {
    await esClient.indices.create({
      index: 'stories',
      body: {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
        },
        mappings: {
          properties: {
            title: { type: 'text', analyzer: 'english' },
            summary: { type: 'text', analyzer: 'english' },
            primary_topic: { type: 'keyword' },
            topics: { type: 'keyword' },
            velocity: { type: 'float' },
            is_breaking: { type: 'boolean' },
            article_count: { type: 'integer' },
            created_at: { type: 'date' },
            updated_at: { type: 'date' },
          },
        },
      },
    });
    console.log('Created stories index in Elasticsearch');
  }
}

// Index an article
export async function indexArticle(article: {
  id: string;
  title: string;
  summary?: string;
  body?: string;
  topics?: string[];
  entities?: { name: string; type: string }[];
  published_at?: Date;
  source_id: string;
  story_id?: string;
  fingerprint?: bigint;
}): Promise<void> {
  await esClient.index({
    index: 'articles',
    id: article.id,
    body: {
      ...article,
      fingerprint: article.fingerprint ? Number(article.fingerprint) : null,
    },
  });
}

// Index a story
export async function indexStory(story: {
  id: string;
  title: string;
  summary?: string;
  primary_topic?: string;
  topics?: string[];
  velocity?: number;
  is_breaking?: boolean;
  article_count?: number;
  created_at?: Date;
  updated_at?: Date;
}): Promise<void> {
  await esClient.index({
    index: 'stories',
    id: story.id,
    body: story,
  });
}

// Search articles
export async function searchArticles(
  query: string,
  options: {
    topics?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    limit?: number;
  } = {}
): Promise<{ id: string; score: number }[]> {
  const must: object[] = [
    {
      multi_match: {
        query,
        fields: ['title^3', 'summary^2', 'body'],
        type: 'best_fields',
      },
    },
  ];

  if (options.topics?.length) {
    must.push({ terms: { topics: options.topics } });
  }

  const filter: object[] = [];
  if (options.dateFrom || options.dateTo) {
    const range: { gte?: string; lte?: string } = {};
    if (options.dateFrom) range.gte = options.dateFrom.toISOString();
    if (options.dateTo) range.lte = options.dateTo.toISOString();
    filter.push({ range: { published_at: range } });
  }

  const result = await esClient.search({
    index: 'articles',
    body: {
      query: {
        bool: {
          must,
          filter,
        },
      },
      size: options.limit || 20,
    },
  });

  return result.hits.hits.map((hit) => ({
    id: hit._id,
    score: hit._score || 0,
  }));
}
