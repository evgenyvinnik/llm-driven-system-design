import { Client } from '@elastic/elasticsearch';
import { config } from '../config/index.js';

const esClient = new Client({
  node: config.elasticsearch.url,
});

// Document index mapping
const documentIndexMapping = {
  mappings: {
    properties: {
      url: { type: 'keyword' },
      url_id: { type: 'long' },
      title: {
        type: 'text',
        analyzer: 'english',
        fields: {
          keyword: { type: 'keyword' },
          autocomplete: {
            type: 'text',
            analyzer: 'autocomplete',
            search_analyzer: 'autocomplete_search',
          },
        },
      },
      description: {
        type: 'text',
        analyzer: 'english',
      },
      content: {
        type: 'text',
        analyzer: 'english',
        term_vector: 'with_positions_offsets',
      },
      domain: { type: 'keyword' },
      page_rank: { type: 'float' },
      inlink_count: { type: 'integer' },
      fetch_time: { type: 'date' },
      content_length: { type: 'integer' },
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
        type: 'text',
        analyzer: 'autocomplete',
        search_analyzer: 'autocomplete_search',
        fields: {
          keyword: { type: 'keyword' },
        },
      },
      frequency: { type: 'integer' },
      last_used: { type: 'date' },
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
export const initializeIndices = async () => {
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
    console.error('Failed to initialize Elasticsearch indices:', error.message);
  }
};

// Index a document
export const indexDocument = async (doc) => {
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
export const bulkIndexDocuments = async (docs) => {
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
export const searchDocuments = async (query, options = {}) => {
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

  return {
    total: response.hits.total.value,
    hits: response.hits.hits.map((hit) => ({
      ...hit._source,
      score: hit._score,
      highlight: hit.highlight,
    })),
  };
};

// Get autocomplete suggestions
export const getAutocompleteSuggestions = async (prefix, limit = 10) => {
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
    sort: [{ frequency: 'desc' }, { last_used: 'desc' }],
    size: limit,
    _source: ['query', 'frequency'],
  });

  return response.hits.hits.map((hit) => hit._source.query);
};

// Add search suggestion
export const addSearchSuggestion = async (queryText) => {
  try {
    // Check if suggestion exists
    const exists = await esClient.search({
      index: config.elasticsearch.autocompleteIndex,
      query: {
        term: { 'query.keyword': queryText.toLowerCase() },
      },
      size: 1,
    });

    if (exists.hits.total.value > 0) {
      // Update existing
      const id = exists.hits.hits[0]._id;
      await esClient.update({
        index: config.elasticsearch.autocompleteIndex,
        id,
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
    console.error('Failed to add search suggestion:', error.message);
  }
};

// Update page rank in documents
export const updatePageRanks = async (pageRanks) => {
  const operations = [];

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
