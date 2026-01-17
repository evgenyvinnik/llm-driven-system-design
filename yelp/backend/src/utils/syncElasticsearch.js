import 'dotenv/config';
import { pool } from './db.js';
import { elasticsearch, initElasticsearch, indexBusiness } from './elasticsearch.js';

async function syncElasticsearch() {
  console.log('Starting Elasticsearch sync...');

  try {
    // Initialize index
    await initElasticsearch();

    // Delete existing index and recreate
    try {
      await elasticsearch.indices.delete({ index: 'businesses' });
      console.log('Deleted existing index');
    } catch (e) {
      // Index might not exist
    }

    await initElasticsearch();
    console.log('Created fresh index');

    // Get all businesses with their categories
    const result = await pool.query(`
      SELECT b.*,
             array_agg(DISTINCT c.slug) FILTER (WHERE c.slug IS NOT NULL) as categories,
             array_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL) as category_names,
             (SELECT url FROM business_photos WHERE business_id = b.id AND is_primary = true LIMIT 1) as photo_url
      FROM businesses b
      LEFT JOIN business_categories bc ON b.id = bc.business_id
      LEFT JOIN categories c ON bc.category_id = c.id
      GROUP BY b.id
    `);

    console.log(`Found ${result.rows.length} businesses to index`);

    // Index each business
    let indexed = 0;
    for (const business of result.rows) {
      await indexBusiness(business);
      indexed++;
      if (indexed % 100 === 0) {
        console.log(`Indexed ${indexed} businesses...`);
      }
    }

    console.log(`Successfully indexed ${indexed} businesses`);

    // Refresh index
    await elasticsearch.indices.refresh({ index: 'businesses' });
    console.log('Index refreshed');

  } catch (error) {
    console.error('Sync error:', error);
    process.exit(1);
  }

  process.exit(0);
}

syncElasticsearch();
