import { Client } from '@elastic/elasticsearch';
import { config } from '../config/index.js';

const esClient = new Client({
  node: config.elasticsearch.url,
});

export interface SearchDocument {
  url: string;
  url_id: number;
  title: string;
  description: string;
  content: string;
  domain: string;
  page_rank: number;
  inlink_count: number;
  fetch_time: Date;
  content_length: number;
  _contentHash?: string;
}

export interface SearchHit {
  url: string;
  url_id: number;
  title: string;
  description: string;
  domain: string;
  page_rank: number;
  fetch_time: string;
  score: number;
  highlight?: {
    content?: string[];
    title?: string[];
  };
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
}

// Document index mapping
const documentIndexMapping = {
  mappings: {
    properties: {
      url: { type: 'keyword' as const },
      url_id: { type: 'long' as const },
      title: {
        type: 'text' as const,
        analyzer: 'english',
        fields: {
          keyword: { type: 'keyword' as const },
          autocomplete: {
            type: 'text' as const,
            analyzer: 'autocomplete',
            search_analyzer: 'autocomplete_search',
          },
        },
      },
      description: {
        type: 'text' as const,
        analyzer: 'english',
      },
      content: {
        type: 'text' as const,
        analyzer: 'english',
        term_vector: 'with_positions_offsets',
      },
      domain: { type: 'keyword' as const },
      page_rank: { type: 'float' as const },
      inlink_count: { type: 'integer' as const },
      fetch_time: { type: 'date' as const },
      content_length: { type: 'integer' as const },
    },
  },
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        autocomplete: {
          tokenizer: 'autocomplete',
          filter: ['lowercase'],
        },
        autocomplete_search: {
          tokenizer: 'lowercase',
        },
      },
      tokenizer: {
        autocomplete: {
          type: 'edge_ngram',
          min_gram: 2,
          max_gram: 20,
          token_chars: ['letter', 'digit'],
        },
      },
    },
  },
};

// Autocomplete index for search suggestions
const autocompleteIndexMapping = {
  mappings: {
    properties: {
      query: {
        type: 'text' as const,
        analyzer: 'autocomplete',
        search_analyzer: 'autocomplete_search',
        fields: {
          keyword: { type: 'keyword' as const },
        },
      },
      frequency: { type: 'integer' as const },
      last_used: { type: 'date' as const },
    },
  },
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        autocomplete: {
          tokenizer: 'autocomplete',
          filter: ['lowercase'],
        },
        autocomplete_search: {
          tokenizer: 'lowercase',
        },
      },
      tokenizer: {
        autocomplete: {
          type: 'edge_ngram',
          min_gram: 1,
          max_gram: 20,
          token_chars: ['letter', 'digit', 'whitespace'],
        },
      },
    },
  },
};

// Initialize indices
export const initializeIndices = async (): Promise<void> => {
  try {
    // Check and create document index
    const docIndexExists = await esClient.indices.exists({
      index: config.elasticsearch.documentIndex,
    });

    if (!docIndexExists) {
      await esClient.indices.create({
        index: config.elasticsearch.documentIndex,
        ...documentIndexMapping,
      });
      console.log(`Created index: ${config.elasticsearch.documentIndex}`);
    }

    // Check and create autocomplete index
    const autoIndexExists = await esClient.indices.exists({
      index: config.elasticsearch.autocompleteIndex,
    });

    if (!autoIndexExists) {
      await esClient.indices.create({
        index: config.elasticsearch.autocompleteIndex,
        ...autocompleteIndexMapping,
      });
      console.log(`Created index: ${config.elasticsearch.autocompleteIndex}`);
    }

    console.log('Elasticsearch indices initialized');
  } catch (error) {
    console.error('Failed to initialize Elasticsearch indices:', (error as Error).message);
  }
};

// Index a document
export const indexDocument = async (doc: SearchDocument): Promise<void> => {
  await esClient.index({
    index: config.elasticsearch.documentIndex,
    id: doc.url_id.toString(),
    document: {
      url: doc.url,
      url_id: doc.url_id,
      title: doc.title || '',
      description: doc.description || '',
      content: doc.content || '',
      domain: doc.domain,
      page_rank: doc.page_rank || 0,
      inlink_count: doc.inlink_count || 0,
      fetch_time: doc.fetch_time || new Date(),
      content_length: doc.content_length || 0,
    },
  });
};

// Bulk index documents
export const bulkIndexDocuments = async (docs: SearchDocument[]): Promise<unknown> => {
  if (docs.length === 0) return;

  const operations = docs.flatMap((doc) => [
    { index: { _index: config.elasticsearch.documentIndex, _id: doc.url_id.toString() } },
    {
      url: doc.url,
      url_id: doc.url_id,
      title: doc.title || '',
      description: doc.description || '',
      content: doc.content || '',
      domain: doc.domain,
      page_rank: doc.page_rank || 0,
      inlink_count: doc.inlink_count || 0,
      fetch_time: doc.fetch_time || new Date(),
      content_length: doc.content_length || 0,
    },
  ]);

  const result = await esClient.bulk({
    operations,
    refresh: true,
  });

  if (result.errors) {
    const errorItems = result.items.filter((item) => item.index?.error);
    console.error('Bulk indexing errors:', errorItems);
  }

  return result;
};

// Search documents
export const searchDocuments = async (
  query: string,
  options: { page?: number; limit?: number } = {}
): Promise<SearchResult> => {
  const { page = 1, limit = 10 } = options;
  const from = (page - 1) * limit;

  const response = await esClient.search({
    index: config.elasticsearch.documentIndex,
    query: {
      function_score: {
        query: {
          bool: {
            should: [
              {
                multi_match: {
                  query: query,
                  fields: ['title^3', 'description^2', 'content'],
                  type: 'best_fields',
                  fuzziness: 'AUTO',
                },
              },
              {
                match_phrase: {
                  content: {
                    query: query,
                    boost: 2,
                  },
                },
              },
            ],
            minimum_should_match: 1,
          },
        },
        functions: [
          {
            field_value_factor: {
              field: 'page_rank',
              factor: 1.2,
              modifier: 'log1p',
              missing: 0,
            },
          },
          {
            field_value_factor: {
              field: 'inlink_count',
              factor: 1.1,
              modifier: 'log1p',
              missing: 0,
            },
          },
          {
            gauss: {
              fetch_time: {
                origin: 'now',
                scale: '30d',
                offset: '7d',
                decay: 0.5,
              },
            },
          },
        ],
        score_mode: 'multiply',
        boost_mode: 'multiply',
      },
    },
    from,
    size: limit,
    highlight: {
      fields: {
        content: {
          fragment_size: 150,
          number_of_fragments: 3,
          pre_tags: ['<b>'],
          post_tags: ['</b>'],
        },
        title: {
          pre_tags: ['<b>'],
          post_tags: ['</b>'],
        },
      },
    },
    _source: ['url', 'url_id', 'title', 'description', 'domain', 'page_rank', 'fetch_time'],
  });

  const total = typeof response.hits.total === 'number'
    ? response.hits.total
    : response.hits.total?.value || 0;

  return {
    total,
    hits: response.hits.hits.map((hit) => ({
      ...(hit._source as SearchHit),
      score: hit._score || 0,
      highlight: hit.highlight as { content?: string[]; title?: string[] } | undefined,
    })),
  };
};

// Get autocomplete suggestions
export const getAutocompleteSuggestions = async (prefix: string, limit = 10): Promise<string[]> => {
  const response = await esClient.search({
    index: config.elasticsearch.autocompleteIndex,
    query: {
      bool: {
        must: [
          {
            match: {
              query: {
                query: prefix,
                operator: 'and',
              },
            },
          },
        ],
      },
    },
    sort: [{ frequency: 'desc' as const }, { last_used: 'desc' as const }],
    size: limit,
    _source: ['query', 'frequency'],
  });

  return response.hits.hits.map((hit) => (hit._source as { query: string }).query);
};

// Add search suggestion
export const addSearchSuggestion = async (queryText: string): Promise<void> => {
  try {
    // Check if suggestion exists
    const exists = await esClient.search({
      index: config.elasticsearch.autocompleteIndex,
      query: {
        term: { 'query.keyword': queryText.toLowerCase() },
      },
      size: 1,
    });

    const total = typeof exists.hits.total === 'number'
      ? exists.hits.total
      : exists.hits.total?.value || 0;

    if (total > 0 && exists.hits.hits[0]._id) {
      // Update existing
      const id = exists.hits.hits[0]._id;
      await esClient.update({
        index: config.elasticsearch.autocompleteIndex,
        id: id,
        script: {
          source: 'ctx._source.frequency++; ctx._source.last_used = params.now',
          params: { now: new Date() },
        },
      });
    } else {
      // Create new
      await esClient.index({
        index: config.elasticsearch.autocompleteIndex,
        document: {
          query: queryText.toLowerCase(),
          frequency: 1,
          last_used: new Date(),
        },
      });
    }
  } catch (error) {
    console.error('Failed to add search suggestion:', (error as Error).message);
  }
};

// Update page rank in documents
export const updatePageRanks = async (pageRanks: Record<string, number>): Promise<void> => {
  const operations: unknown[] = [];

  for (const [urlId, rank] of Object.entries(pageRanks)) {
    operations.push(
      { update: { _index: config.elasticsearch.documentIndex, _id: urlId.toString() } },
      { doc: { page_rank: rank } }
    );
  }

  if (operations.length > 0) {
    await esClient.bulk({ operations, refresh: true });
  }
};

export { esClient };
