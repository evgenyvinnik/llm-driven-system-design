/**
 * The shared Elasticsearch client.
 *
 * This lives in its own module rather than in `index.ts` so that things which
 * need Elasticsearch but not the HTTP server — chiefly `seed.ts` — can import
 * the search helpers without importing the server entry point, which calls
 * `app.listen()` as a side effect of being imported.
 */
import { Client } from '@elastic/elasticsearch';

export const esClient = new Client({
  node: process.env.ES_URL || 'http://localhost:9200',
});
