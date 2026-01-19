/**
 * Seed script to populate the typeahead database with sample phrases.
 * Run with: npm run seed
 */

import pg from 'pg';

const pgPool = new pg.Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'typeahead',
  password: process.env.PG_PASSWORD || 'typeahead_password',
  database: process.env.PG_DATABASE || 'typeahead',
});

// Sample phrases with popularity counts
const samplePhrases = [
  // Tech
  { phrase: 'javascript', count: 50000 },
  { phrase: 'javascript tutorial', count: 35000 },
  { phrase: 'javascript array methods', count: 28000 },
  { phrase: 'javascript async await', count: 25000 },
  { phrase: 'javascript map function', count: 22000 },
  { phrase: 'java', count: 45000 },
  { phrase: 'java vs javascript', count: 18000 },
  { phrase: 'java spring boot', count: 15000 },
  { phrase: 'python', count: 55000 },
  { phrase: 'python tutorial', count: 40000 },
  { phrase: 'python for beginners', count: 32000 },
  { phrase: 'python machine learning', count: 28000 },
  { phrase: 'python pandas', count: 25000 },
  { phrase: 'python django', count: 22000 },
  { phrase: 'react', count: 48000 },
  { phrase: 'react tutorial', count: 38000 },
  { phrase: 'react hooks', count: 35000 },
  { phrase: 'react native', count: 30000 },
  { phrase: 'react router', count: 25000 },
  { phrase: 'react vs vue', count: 20000 },
  { phrase: 'typescript', count: 42000 },
  { phrase: 'typescript tutorial', count: 32000 },
  { phrase: 'typescript vs javascript', count: 25000 },
  { phrase: 'typescript generics', count: 18000 },
  { phrase: 'node', count: 40000 },
  { phrase: 'nodejs', count: 38000 },
  { phrase: 'nodejs tutorial', count: 30000 },
  { phrase: 'nodejs express', count: 28000 },

  // General
  { phrase: 'weather today', count: 100000 },
  { phrase: 'weather forecast', count: 85000 },
  { phrase: 'weather tomorrow', count: 70000 },
  { phrase: 'what time is it', count: 60000 },
  { phrase: 'what is my ip', count: 55000 },
  { phrase: 'why is the sky blue', count: 45000 },
  { phrase: 'how to', count: 200000 },
  { phrase: 'how to cook rice', count: 50000 },
  { phrase: 'how to tie a tie', count: 45000 },
  { phrase: 'how to lose weight', count: 80000 },
  { phrase: 'how to learn programming', count: 35000 },
  { phrase: 'best restaurants near me', count: 90000 },
  { phrase: 'best pizza near me', count: 75000 },
  { phrase: 'best coffee near me', count: 65000 },
  { phrase: 'news', count: 150000 },
  { phrase: 'news today', count: 120000 },
  { phrase: 'news politics', count: 80000 },
  { phrase: 'netflix', count: 180000 },
  { phrase: 'netflix movies', count: 100000 },
  { phrase: 'netflix shows', count: 95000 },
  { phrase: 'new movies', count: 85000 },
  { phrase: 'new music', count: 70000 },

  // Shopping
  { phrase: 'amazon', count: 200000 },
  { phrase: 'amazon prime', count: 150000 },
  { phrase: 'amazon delivery', count: 90000 },
  { phrase: 'apple', count: 180000 },
  { phrase: 'apple iphone', count: 120000 },
  { phrase: 'apple macbook', count: 80000 },

  // Social
  { phrase: 'facebook', count: 250000 },
  { phrase: 'facebook login', count: 180000 },
  { phrase: 'facebook marketplace', count: 100000 },
  { phrase: 'instagram', count: 220000 },
  { phrase: 'instagram reels', count: 120000 },
  { phrase: 'instagram stories', count: 100000 },
  { phrase: 'twitter', count: 180000 },
  { phrase: 'tiktok', count: 200000 },
  { phrase: 'tiktok trends', count: 90000 },

  // Food
  { phrase: 'recipe', count: 120000 },
  { phrase: 'recipe chicken', count: 80000 },
  { phrase: 'recipe pasta', count: 75000 },
  { phrase: 'recipe cookies', count: 60000 },
  { phrase: 'restaurant', count: 150000 },
  { phrase: 'restaurants near me', count: 130000 },

  // Travel
  { phrase: 'flights', count: 140000 },
  { phrase: 'flights to new york', count: 60000 },
  { phrase: 'flights to los angeles', count: 55000 },
  { phrase: 'flights cheap', count: 90000 },
  { phrase: 'hotel', count: 130000 },
  { phrase: 'hotels near me', count: 100000 },
  { phrase: 'hotels in vegas', count: 70000 },

  // More tech
  { phrase: 'docker', count: 35000 },
  { phrase: 'docker tutorial', count: 28000 },
  { phrase: 'docker compose', count: 25000 },
  { phrase: 'kubernetes', count: 30000 },
  { phrase: 'kubernetes tutorial', count: 22000 },
  { phrase: 'git', count: 45000 },
  { phrase: 'git commands', count: 38000 },
  { phrase: 'github', count: 60000 },
  { phrase: 'github actions', count: 35000 },
  { phrase: 'google', count: 300000 },
  { phrase: 'google maps', count: 200000 },
  { phrase: 'google translate', count: 180000 },
  { phrase: 'gmail', count: 220000 },
  { phrase: 'google drive', count: 150000 },

  // Additional variety
  { phrase: 'youtube', count: 280000 },
  { phrase: 'youtube music', count: 150000 },
  { phrase: 'youtube download', count: 100000 },
  { phrase: 'zoom', count: 180000 },
  { phrase: 'zoom meeting', count: 120000 },
  { phrase: 'zara', count: 80000 },
  { phrase: 'zelle', count: 70000 },
  { phrase: 'zillow', count: 90000 },
  { phrase: 'xbox', count: 100000 },
  { phrase: 'x ray', count: 50000 },
];

async function seed() {
  console.log('Seeding database with sample phrases...');

  try {
    // Clear existing data
    await pgPool.query('TRUNCATE TABLE phrase_counts CASCADE');
    await pgPool.query('TRUNCATE TABLE query_logs CASCADE');
    console.log('Cleared existing data');

    // Insert sample phrases
    for (const { phrase, count } of samplePhrases) {
      await pgPool.query(
        `INSERT INTO phrase_counts (phrase, count, last_updated)
         VALUES ($1, $2, NOW())
         ON CONFLICT (phrase)
         DO UPDATE SET count = $2, last_updated = NOW()`,
        [phrase.toLowerCase(), count]
      );
    }

    console.log(`Inserted ${samplePhrases.length} phrases`);

    // Verify
    const result = await pgPool.query('SELECT COUNT(*) as count FROM phrase_counts');
    console.log(`Total phrases in database: ${result.rows[0].count}`);

    console.log('Seeding complete!');
  } catch (error) {
    console.error('Seeding error:', error);
    process.exit(1);
  } finally {
    await pgPool.end();
  }
}

seed();
