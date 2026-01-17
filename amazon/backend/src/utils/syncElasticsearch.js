import 'dotenv/config';
import { initializeDb, query } from '../services/database.js';
import { initializeElasticsearch, bulkIndexProducts } from '../services/elasticsearch.js';

async function syncElasticsearch() {
  try {
    console.log('Connecting to database...');
    await initializeDb();

    console.log('Connecting to Elasticsearch...');
    await initializeElasticsearch();

    console.log('Fetching products...');
    const result = await query(
      `SELECT p.*, c.name as category_name, c.slug as category_slug,
              s.business_name as seller_name,
              COALESCE(SUM(i.quantity - i.reserved), 0) as stock_quantity
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN sellers s ON p.seller_id = s.id
       LEFT JOIN inventory i ON p.id = i.product_id
       WHERE p.is_active = true
       GROUP BY p.id, c.name, c.slug, s.business_name`
    );

    console.log(`Found ${result.rows.length} products to index`);

    if (result.rows.length > 0) {
      await bulkIndexProducts(result.rows);
      console.log('Products indexed successfully!');
    }

    process.exit(0);
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  }
}

syncElasticsearch();
