import { Client } from '@elastic/elasticsearch';
import { esClient } from './esClient.js';

export interface IndexConfig {
  name: string;
  mappings: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface SearchOptions {
  limit?: number;
  types?: string[];
}

export interface SearchResult {
  id: string;
  type: string;
  score: number | null;
  [key: string]: unknown;
}

export interface SuggestionResult {
  id: string;
  type: string;
  name: string;
  [key: string]: unknown;
}

// Initialize Elasticsearch indices with proper mappings
/** Initializes Elasticsearch indices with mappings for searchable documents. */
export async function initializeElasticsearch(client: Client): Promise<void> {
  const indices: IndexConfig[] = [
    {
      name: 'spotlight_files',
      mappings: {
        properties: {
          path: { type: 'keyword' },
          name: {
            type: 'text',
            analyzer: 'standard',
            fields: {
              keyword: { type: 'keyword' },
              prefix: {
                type: 'text',
                analyzer: 'edge_ngram_analyzer',
                search_analyzer: 'standard'
              }
            }
          },
          content: { type: 'text', analyzer: 'standard' },
          type: { type: 'keyword' },
          size: { type: 'long' },
          // The cross-index function_score scores decay on modified_at,
          // last_used and usage_count. Elasticsearch parses that query against
          // *every* index it searches, and an unmapped field in any one of them
          // is a hard parsing_exception — not a skipped function. So all four
          // mappings declare all three fields even where they carry no data;
          // a mapped-but-absent field makes the decay neutral instead of fatal.
          modified_at: { type: 'date' },
          last_used: { type: 'date' },
          usage_count: { type: 'integer' },
          indexed_at: { type: 'date' },
          metadata: { type: 'object', enabled: false }
        }
      },
      settings: {
        analysis: {
          analyzer: {
            edge_ngram_analyzer: {
              type: 'custom',
              tokenizer: 'edge_ngram_tokenizer',
              filter: ['lowercase']
            }
          },
          tokenizer: {
            edge_ngram_tokenizer: {
              type: 'edge_ngram',
              min_gram: 1,
              max_gram: 20,
              token_chars: ['letter', 'digit']
            }
          }
        }
      }
    },
    {
      name: 'spotlight_apps',
      mappings: {
        properties: {
          bundle_id: { type: 'keyword' },
          name: {
            type: 'text',
            fields: {
              keyword: { type: 'keyword' },
              prefix: {
                type: 'text',
                analyzer: 'edge_ngram_analyzer',
                search_analyzer: 'standard'
              }
            }
          },
          path: { type: 'keyword' },
          category: { type: 'keyword' },
          // The cross-index function_score scores decay on modified_at,
          // last_used and usage_count. Elasticsearch parses that query against
          // *every* index it searches, and an unmapped field in any one of them
          // is a hard parsing_exception — not a skipped function. So all four
          // mappings declare all three fields even where they carry no data;
          // a mapped-but-absent field makes the decay neutral instead of fatal.
          usage_count: { type: 'integer' },
          last_used: { type: 'date' },
          modified_at: { type: 'date' }
        }
      },
      settings: {
        analysis: {
          analyzer: {
            edge_ngram_analyzer: {
              type: 'custom',
              tokenizer: 'edge_ngram_tokenizer',
              filter: ['lowercase']
            }
          },
          tokenizer: {
            edge_ngram_tokenizer: {
              type: 'edge_ngram',
              min_gram: 1,
              max_gram: 20,
              token_chars: ['letter', 'digit']
            }
          }
        }
      }
    },
    {
      name: 'spotlight_contacts',
      mappings: {
        properties: {
          name: {
            type: 'text',
            fields: {
              keyword: { type: 'keyword' },
              prefix: {
                type: 'text',
                analyzer: 'edge_ngram_analyzer',
                search_analyzer: 'standard'
              }
            }
          },
          email: { type: 'keyword' },
          phone: { type: 'keyword' },
          company: { type: 'text' },
          notes: { type: 'text' },
          // The cross-index function_score scores decay on modified_at,
          // last_used and usage_count. Elasticsearch parses that query against
          // *every* index it searches, and an unmapped field in any one of them
          // is a hard parsing_exception — not a skipped function. So all four
          // mappings declare all three fields even where they carry no data;
          // a mapped-but-absent field makes the decay neutral instead of fatal.
          modified_at: { type: 'date' },
          last_used: { type: 'date' },
          usage_count: { type: 'integer' }
        }
      },
      settings: {
        analysis: {
          analyzer: {
            edge_ngram_analyzer: {
              type: 'custom',
              tokenizer: 'edge_ngram_tokenizer',
              filter: ['lowercase']
            }
          },
          tokenizer: {
            edge_ngram_tokenizer: {
              type: 'edge_ngram',
              min_gram: 1,
              max_gram: 20,
              token_chars: ['letter', 'digit']
            }
          }
        }
      }
    },
    {
      name: 'spotlight_web',
      mappings: {
        properties: {
          url: { type: 'keyword' },
          title: {
            type: 'text',
            fields: {
              keyword: { type: 'keyword' },
              prefix: {
                type: 'text',
                analyzer: 'edge_ngram_analyzer',
                search_analyzer: 'standard'
              }
            }
          },
          description: { type: 'text' },
          visited_count: { type: 'integer' },
          last_visited: { type: 'date' },
          // The cross-index function_score scores decay on modified_at,
          // last_used and usage_count. Elasticsearch parses that query against
          // *every* index it searches, and an unmapped field in any one of them
          // is a hard parsing_exception — not a skipped function. So all four
          // mappings declare all three fields even where they carry no data;
          // a mapped-but-absent field makes the decay neutral instead of fatal.
          modified_at: { type: 'date' },
          last_used: { type: 'date' },
          usage_count: { type: 'integer' }
        }
      },
      settings: {
        analysis: {
          analyzer: {
            edge_ngram_analyzer: {
              type: 'custom',
              tokenizer: 'edge_ngram_tokenizer',
              filter: ['lowercase']
            }
          },
          tokenizer: {
            edge_ngram_tokenizer: {
              type: 'edge_ngram',
              min_gram: 1,
              max_gram: 20,
              token_chars: ['letter', 'digit']
            }
          }
        }
      }
    }
  ];

  for (const index of indices) {
    const exists = await client.indices.exists({ index: index.name });

    if (!exists) {
      await client.indices.create({
        index: index.name,
        body: {
          settings: index.settings,
          mappings: index.mappings
        }
      });
      console.log(`Created index: ${index.name}`);
    } else {
      // An index can exist without our mapping. Anything that writes a document
      // before this function runs — the seed script, a bulk import — makes
      // Elasticsearch auto-create the index with a *dynamic* mapping inferred
      // from that document. Fields absent from the sample (last_used on a
      // contact, modified_at on a bookmark) then never get mapped at all, and
      // because the cross-index function_score references them, every search
      // fails with `unknown field` rather than degrading.
      //
      // Mapping updates are additive and idempotent, so re-PUTting on every
      // boot costs nothing and makes a mis-ordered startup self-healing.
      try {
        await client.indices.putMapping({
          index: index.name,
          properties: index.mappings.properties
        } as Parameters<typeof client.indices.putMapping>[0]);
      } catch (error) {
        console.error(`Could not reconcile mapping for ${index.name}:`, error);
      }
    }
  }
}

// Search across all indices
export async function searchAll(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const { limit = 20, types = ['files', 'apps', 'contacts', 'web'] } = options;

  const indices = types.map(t => `spotlight_${t}`);

  const response = await esClient.search({
    index: indices,
    size: limit,
    query: {
      function_score: {
        query: {
          bool: {
            should: [
              // Prefix matching on name fields
              {
                multi_match: {
                  query,
                  fields: ['name.prefix^3', 'title.prefix^3', 'name^2', 'title^2', 'content'],
                  type: 'best_fields'
                }
              },
              // Fuzzy matching for typo tolerance
              {
                multi_match: {
                  query,
                  fields: ['name', 'title', 'content'],
                  fuzziness: 'AUTO',
                  prefix_length: 2
                }
              }
            ],
            minimum_should_match: 1
          }
        },
        // Boost recent and frequently used items
        functions: [
          {
            gauss: {
              modified_at: {
                origin: 'now',
                scale: '7d',
                decay: 0.5
              }
            },
            weight: 2
          },
          {
            gauss: {
              last_used: {
                origin: 'now',
                scale: '3d',
                decay: 0.5
              }
            },
            weight: 3
          },
          {
            field_value_factor: {
              field: 'usage_count',
              factor: 0.1,
              modifier: 'log1p',
              missing: 1
            }
          }
        ],
        score_mode: 'sum',
        boost_mode: 'multiply'
      }
    }
  });

  return response.hits.hits.map(hit => ({
    id: hit._id!,
    type: hit._index.replace('spotlight_', ''),
    score: hit._score ?? null,
    ...(hit._source as Record<string, unknown>)
  }));
}

// Index a document
export async function indexDocument(indexName: string, id: string, document: Record<string, unknown>): Promise<void> {
  await esClient.index({
    index: `spotlight_${indexName}`,
    id,
    body: document,
    refresh: true
  });
}

// Delete a document
export async function deleteDocument(indexName: string, id: string): Promise<void> {
  try {
    await esClient.delete({
      index: `spotlight_${indexName}`,
      id,
      refresh: true
    });
  } catch (error) {
    const err = error as { meta?: { statusCode?: number } };
    if (err.meta?.statusCode !== 404) {
      throw error;
    }
  }
}

// Get suggestions based on prefix
export async function getSuggestions(prefix: string, limit: number = 10): Promise<SuggestionResult[]> {
  const response = await esClient.search({
    index: ['spotlight_files', 'spotlight_apps', 'spotlight_contacts', 'spotlight_web'],
    size: limit,
    query: {
      bool: {
        should: [
          {
            prefix: {
              'name.keyword': {
                value: prefix.toLowerCase(),
                boost: 3
              }
            }
          },
          {
            match: {
              'name.prefix': {
                query: prefix,
                boost: 2
              }
            }
          }
        ]
      }
    },
    _source: ['name', 'title', 'type', 'bundle_id', 'url']
  });

  return response.hits.hits.map(hit => {
    const source = hit._source as Record<string, unknown>;
    return {
      id: hit._id!,
      type: hit._index.replace('spotlight_', ''),
      name: (source.name || source.title) as string,
      ...source
    };
  });
}
