/**
 * @fileoverview Database seeding script for the App Store.
 * Creates demo users, categories, sample apps, and reviews.
 * Run with: npm run db:seed
 */

import { pool } from '../config/database.js';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { esClient, APP_INDEX, initializeElasticsearch } from '../config/elasticsearch.js';

/**
 * Category definitions with subcategories for the app store.
 * Each category has a name, URL-safe slug, icon, and list of subcategories.
 */
const categories = [
  { name: 'Games', slug: 'games', icon: 'gamepad', subcategories: ['Action', 'Puzzle', 'Strategy', 'Adventure', 'Simulation', 'Racing'] },
  { name: 'Productivity', slug: 'productivity', icon: 'briefcase', subcategories: ['Documents', 'Notes', 'Task Management', 'Calendar'] },
  { name: 'Social Networking', slug: 'social', icon: 'users', subcategories: ['Messaging', 'Dating', 'Forums'] },
  { name: 'Photo & Video', slug: 'photo-video', icon: 'camera', subcategories: ['Editing', 'Filters', 'Camera'] },
  { name: 'Entertainment', slug: 'entertainment', icon: 'film', subcategories: ['Streaming', 'Music', 'Podcasts'] },
  { name: 'Education', slug: 'education', icon: 'book', subcategories: ['Language', 'Kids', 'Reference'] },
  { name: 'Health & Fitness', slug: 'health-fitness', icon: 'heart', subcategories: ['Workout', 'Diet', 'Mental Health'] },
  { name: 'Finance', slug: 'finance', icon: 'dollar-sign', subcategories: ['Banking', 'Investing', 'Budgeting'] },
  { name: 'Utilities', slug: 'utilities', icon: 'tool', subcategories: ['Weather', 'Calculator', 'Scanner'] },
  { name: 'Travel', slug: 'travel', icon: 'map', subcategories: ['Navigation', 'Booking', 'Guides'] },
];

/**
 * Sample app definitions for seeding the catalog.
 * Each app has metadata, pricing, and category assignment.
 */
const sampleApps = [
  {
    bundleId: 'com.example.photomagic',
    name: 'PhotoMagic Pro',
    description: 'Transform your photos with AI-powered editing tools. Apply stunning filters, remove backgrounds, and enhance your images like never before.',
    shortDescription: 'AI-powered photo editing',
    keywords: ['photo', 'editing', 'ai', 'filters', 'enhance'],
    category: 'photo-video',
    isFree: false,
    price: 4.99,
    ageRating: '4+',
    version: '2.1.0',
    sizeBytes: 125000000,
  },
  {
    bundleId: 'com.example.taskmaster',
    name: 'TaskMaster',
    description: 'The ultimate task management app for busy professionals. Organize your work, set reminders, and boost your productivity.',
    shortDescription: 'Smart task management',
    keywords: ['tasks', 'productivity', 'todo', 'reminders', 'organize'],
    category: 'productivity',
    isFree: true,
    price: 0,
    ageRating: '4+',
    version: '3.0.5',
    sizeBytes: 45000000,
  },
  {
    bundleId: 'com.example.spacequest',
    name: 'Space Quest Adventures',
    description: 'Embark on an epic journey through the galaxy. Battle aliens, explore planets, and save the universe in this action-packed adventure.',
    shortDescription: 'Epic space adventure game',
    keywords: ['game', 'space', 'adventure', 'action', 'aliens'],
    category: 'games',
    isFree: true,
    price: 0,
    ageRating: '9+',
    version: '1.5.2',
    sizeBytes: 350000000,
  },
  {
    bundleId: 'com.example.fittrack',
    name: 'FitTrack Pro',
    description: 'Your personal fitness companion. Track workouts, count calories, and achieve your health goals with detailed analytics.',
    shortDescription: 'Complete fitness tracker',
    keywords: ['fitness', 'workout', 'health', 'exercise', 'calories'],
    category: 'health-fitness',
    isFree: false,
    price: 9.99,
    ageRating: '4+',
    version: '4.2.1',
    sizeBytes: 85000000,
  },
  {
    bundleId: 'com.example.socialstream',
    name: 'SocialStream',
    description: 'Connect with friends, share moments, and discover trending content. The social app for the modern generation.',
    shortDescription: 'Modern social networking',
    keywords: ['social', 'networking', 'friends', 'chat', 'share'],
    category: 'social',
    isFree: true,
    price: 0,
    ageRating: '12+',
    version: '5.1.0',
    sizeBytes: 110000000,
  },
  {
    bundleId: 'com.example.weathernow',
    name: 'WeatherNow',
    description: 'Accurate weather forecasts at your fingertips. Get hourly, daily, and weekly forecasts with radar maps and severe weather alerts.',
    shortDescription: 'Accurate weather forecasts',
    keywords: ['weather', 'forecast', 'radar', 'alerts', 'temperature'],
    category: 'utilities',
    isFree: true,
    price: 0,
    ageRating: '4+',
    version: '2.8.3',
    sizeBytes: 35000000,
  },
  {
    bundleId: 'com.example.learnlingo',
    name: 'LearnLingo',
    description: 'Master new languages with fun, interactive lessons. AI-powered speech recognition helps you perfect your pronunciation.',
    shortDescription: 'Interactive language learning',
    keywords: ['language', 'learning', 'education', 'spanish', 'french'],
    category: 'education',
    isFree: false,
    price: 14.99,
    ageRating: '4+',
    version: '3.5.0',
    sizeBytes: 200000000,
  },
  {
    bundleId: 'com.example.budgetwise',
    name: 'BudgetWise',
    description: 'Take control of your finances. Track expenses, set budgets, and visualize your spending with beautiful charts.',
    shortDescription: 'Smart budget management',
    keywords: ['budget', 'finance', 'money', 'expenses', 'savings'],
    category: 'finance',
    isFree: true,
    price: 0,
    ageRating: '4+',
    version: '2.3.1',
    sizeBytes: 55000000,
  },
  {
    bundleId: 'com.example.puzzlemania',
    name: 'Puzzle Mania',
    description: 'Challenge your brain with thousands of puzzles. From easy to expert, there is something for everyone.',
    shortDescription: 'Brain-teasing puzzles',
    keywords: ['puzzle', 'game', 'brain', 'logic', 'challenge'],
    category: 'games',
    isFree: true,
    price: 0,
    ageRating: '4+',
    version: '1.9.8',
    sizeBytes: 150000000,
  },
  {
    bundleId: 'com.example.streammax',
    name: 'StreamMax',
    description: 'Watch your favorite shows and movies anytime, anywhere. Thousands of titles available in HD quality.',
    shortDescription: 'Stream movies and shows',
    keywords: ['streaming', 'movies', 'shows', 'entertainment', 'video'],
    category: 'entertainment',
    isFree: false,
    price: 6.99,
    ageRating: '12+',
    version: '4.0.2',
    sizeBytes: 95000000,
  },
];

/**
 * Seeds the database with demo data for development and testing.
 * Creates users (admin, developer, regular), categories, apps, and sample reviews.
 * Also indexes apps in Elasticsearch for search functionality.
 */
async function seed() {
  console.log('Starting seed...');

  // Create admin and developer users
  const adminPasswordHash = await bcrypt.hash('admin123', 10);
  const developerPasswordHash = await bcrypt.hash('developer123', 10);
  const userPasswordHash = await bcrypt.hash('user123', 10);

  const adminId = uuid();
  const developerId = uuid();
  const userId = uuid();

  await pool.query(`
    INSERT INTO users (id, email, password_hash, username, display_name, role)
    VALUES
      ($1, 'admin@appstore.dev', $2, 'admin', 'Admin User', 'admin'),
      ($3, 'developer@appstore.dev', $4, 'developer', 'Demo Developer', 'developer'),
      ($5, 'user@appstore.dev', $6, 'demouser', 'Demo User', 'user')
    ON CONFLICT (email) DO NOTHING
  `, [adminId, adminPasswordHash, developerId, developerPasswordHash, userId, userPasswordHash]);

  console.log('Created users');

  // Create developer account
  const developerAccountId = uuid();
  await pool.query(`
    INSERT INTO developers (id, user_id, name, email, website, description, verified)
    VALUES ($1, $2, 'Demo Studios', 'developer@appstore.dev', 'https://demostudios.example.com', 'A demo developer studio for testing', true)
    ON CONFLICT DO NOTHING
  `, [developerAccountId, developerId]);

  console.log('Created developer account');

  // Create categories
  const categoryMap: Record<string, string> = {};
  for (const cat of categories) {
    const catId = uuid();
    await pool.query(`
      INSERT INTO categories (id, name, slug, icon)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (slug) DO UPDATE SET name = $2
      RETURNING id
    `, [catId, cat.name, cat.slug, cat.icon]);

    categoryMap[cat.slug] = catId;

    // Create subcategories
    for (let i = 0; i < cat.subcategories.length; i++) {
      const subSlug = `${cat.slug}-${cat.subcategories[i].toLowerCase().replace(/\s+/g, '-')}`;
      await pool.query(`
        INSERT INTO categories (id, name, slug, parent_id, sort_order)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (slug) DO NOTHING
      `, [uuid(), cat.subcategories[i], subSlug, catId, i]);
    }
  }

  console.log('Created categories');

  // Initialize Elasticsearch
  await initializeElasticsearch();

  // Create sample apps
  for (const app of sampleApps) {
    const appId = uuid();
    const categoryId = categoryMap[app.category];
    const downloadCount = Math.floor(Math.random() * 100000);
    const ratingCount = Math.floor(Math.random() * 500) + 10;
    const avgRating = (Math.random() * 2 + 3).toFixed(2); // 3.0 - 5.0
    const ratingSum = parseFloat(avgRating) * ratingCount;

    await pool.query(`
      INSERT INTO apps (
        id, bundle_id, name, developer_id, category_id, description, short_description,
        keywords, version, size_bytes, age_rating, is_free, price, currency,
        download_count, rating_sum, rating_count, average_rating, status, published_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'USD', $14, $15, $16, $17, 'published', NOW())
      ON CONFLICT (bundle_id) DO NOTHING
    `, [
      appId, app.bundleId, app.name, developerAccountId, categoryId,
      app.description, app.shortDescription, app.keywords, app.version,
      app.sizeBytes, app.ageRating, app.isFree, app.price,
      downloadCount, ratingSum, ratingCount, avgRating
    ]);

    // Index in Elasticsearch
    await esClient.index({
      index: APP_INDEX,
      id: appId,
      document: {
        id: appId,
        bundleId: app.bundleId,
        name: app.name,
        developer: 'Demo Studios',
        developerId: developerAccountId,
        description: app.description,
        keywords: app.keywords.join(' '),
        category: app.category,
        isFree: app.isFree,
        price: app.price,
        averageRating: parseFloat(avgRating),
        ratingCount,
        downloadCount,
        releaseDate: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        ageRating: app.ageRating,
        size: app.sizeBytes,
        version: app.version,
        qualityScore: Math.random() * 0.5 + 0.5,
        engagementScore: Math.random() * 0.5 + 0.5,
      },
    });

    // Add some sample reviews
    const numReviews = Math.floor(Math.random() * 5) + 2;
    for (let i = 0; i < numReviews; i++) {
      const rating = Math.floor(Math.random() * 3) + 3; // 3-5
      const reviewTitles = ['Great app!', 'Love it', 'Very useful', 'Good but could be better', 'Amazing'];
      const reviewBodies = [
        'This app has changed how I work. Highly recommended!',
        'Simple and intuitive. Does exactly what I need.',
        'Great features, occasional bugs but overall solid.',
        'Been using this for months. Cannot imagine life without it.',
        'The latest update made it even better. Five stars!',
      ];

      await pool.query(`
        INSERT INTO reviews (id, user_id, app_id, rating, title, body, app_version, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'published')
        ON CONFLICT DO NOTHING
      `, [uuid(), userId, appId, rating, reviewTitles[i % reviewTitles.length], reviewBodies[i % reviewBodies.length], app.version]);
    }

    console.log(`Created app: ${app.name}`);
  }

  // Refresh Elasticsearch index
  await esClient.indices.refresh({ index: APP_INDEX });

  console.log('Seed completed successfully');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
