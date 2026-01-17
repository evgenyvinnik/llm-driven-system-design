import { Client } from '@elastic/elasticsearch';

const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
});

// Initialize code search index
export async function initializeCodeIndex() {
  const indexName = 'code';

  const exists = await esClient.indices.exists({ index: indexName });

  if (!exists) {
    await esClient.indices.create({
      index: indexName,
      body: {
        settings: {
          analysis: {
            analyzer: {
              code_analyzer: {
                type: 'custom',
                tokenizer: 'code_tokenizer',
                filter: ['lowercase', 'camelcase_split'],
              },
            },
            tokenizer: {
              code_tokenizer: {
                type: 'pattern',
                pattern: '[^a-zA-Z0-9_]+',
              },
            },
            filter: {
              camelcase_split: {
                type: 'word_delimiter',
                split_on_case_change: true,
              },
            },
          },
        },
        mappings: {
          properties: {
            repo_id: { type: 'keyword' },
            repo_name: { type: 'keyword' },
            owner: { type: 'keyword' },
            path: { type: 'keyword' },
            filename: { type: 'keyword' },
            extension: { type: 'keyword' },
            language: { type: 'keyword' },
            content: { type: 'text', analyzer: 'code_analyzer' },
            symbols: {
              type: 'nested',
              properties: {
                name: { type: 'keyword' },
                kind: { type: 'keyword' },
                line: { type: 'integer' },
              },
            },
            indexed_at: { type: 'date' },
          },
        },
      },
    });
    console.log('Created Elasticsearch code index');
  }
}

export default esClient;
