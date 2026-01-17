import { Client } from '@elastic/elasticsearch';
import { config } from '../shared/config.js';

/**
 * Elasticsearch client for full-text search capabilities.
 * Enables fast, relevance-ranked searching across articles and stories.
 */
export const esClient = new Client({
  node: config.elasticsearch.url,
});

/**
 * Initialize Elasticsearch indexes for articles and stories.
 * Creates indexes with appropriate mappings if they don't exist.
 * Should be called once during application startup.
 * @returns Promise that resolves when initialization is complete
 */
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

/**
 * Index an article for full-text search.
 * Allows the article to be found through search queries on title, summary, and body.
 * @param article - The article data to index
 * @param article.id - Unique article identifier (used as document ID)
 * @param article.title - Article headline
 * @param article.summary - Brief description of the article
 * @param article.body - Full article text content
 * @param article.topics - Array of topic classifications
 * @param article.entities - Named entities extracted from the article
 * @param article.published_at - Publication timestamp
 * @param article.source_id - ID of the news source
 * @param article.story_id - ID of the story cluster (if assigned)
 * @param article.fingerprint - SimHash fingerprint for deduplication
 */
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

/**
 * Index a story for full-text search.
 * Stories represent clusters of related articles about the same topic.
 * @param story - The story data to index
 * @param story.id - Unique story identifier (used as document ID)
 * @param story.title - Representative headline for the story
 * @param story.summary - Brief summary of the story
 * @param story.primary_topic - Main topic classification
 * @param story.topics - All topic classifications
 * @param story.velocity - Rate of new articles being added
 * @param story.is_breaking - Whether this is breaking news
 * @param story.article_count - Number of articles in this story
 * @param story.created_at - When the story was first detected
 * @param story.updated_at - Last update timestamp
 */
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

/**
 * Search articles using full-text search with optional filters.
 * Returns articles ranked by relevance, with title matches weighted highest.
 * @param query - The search query string
 * @param options - Search options for filtering
 * @param options.topics - Filter to articles matching any of these topics
 * @param options.dateFrom - Filter to articles published on or after this date
 * @param options.dateTo - Filter to articles published on or before this date
 * @param options.limit - Maximum number of results to return (default: 20)
 * @returns Array of article IDs with their relevance scores
 */
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
    id: hit._id!,
    score: hit._score || 0,
  }));
}
