import bcrypt from 'bcryptjs';
import { pool, elasticsearch, redis } from './index.js';

/**
 * Database seeding script for development and testing.
 * Creates sample users, preferences, photos, swipes, matches, and messages.
 * Run with: npm run db:seed
 */

/**
 * Sample user data for seeding.
 * Includes one admin user and multiple regular users with varied profiles.
 */
const SAMPLE_USERS = [
  {
    email: 'admin@example.com',
    password: 'admin123',
    name: 'Admin User',
    birthdate: '1990-01-15',
    gender: 'male',
    bio: 'Platform administrator',
    job_title: 'Admin',
    company: 'TinderClone',
    latitude: 40.7128,
    longitude: -74.006,
    is_admin: true,
  },
  {
    email: 'alice@example.com',
    password: 'password123',
    name: 'Alice Johnson',
    birthdate: '1995-03-22',
    gender: 'female',
    bio: 'Love hiking, reading, and trying new restaurants. Looking for someone to share adventures with!',
    job_title: 'Software Engineer',
    company: 'Tech Corp',
    school: 'MIT',
    latitude: 40.7580,
    longitude: -73.9855,
  },
  {
    email: 'bob@example.com',
    password: 'password123',
    name: 'Bob Smith',
    birthdate: '1992-07-10',
    gender: 'male',
    bio: 'Musician and coffee enthusiast. Always up for a spontaneous road trip.',
    job_title: 'Product Manager',
    company: 'StartupXYZ',
    latitude: 40.7484,
    longitude: -73.9857,
  },
  {
    email: 'carol@example.com',
    password: 'password123',
    name: 'Carol Martinez',
    birthdate: '1997-11-05',
    gender: 'female',
    bio: 'Yoga instructor and plant mom. Looking for someone who appreciates good vibes.',
    job_title: 'Yoga Instructor',
    company: 'Zen Studio',
    latitude: 40.7306,
    longitude: -73.9352,
  },
  {
    email: 'david@example.com',
    password: 'password123',
    name: 'David Chen',
    birthdate: '1993-05-18',
    gender: 'male',
    bio: 'Foodie and amateur photographer. Will trade travel stories for good coffee.',
    job_title: 'Data Scientist',
    company: 'Analytics Inc',
    school: 'Stanford',
    latitude: 40.7614,
    longitude: -73.9776,
  },
  {
    email: 'emma@example.com',
    password: 'password123',
    name: 'Emma Wilson',
    birthdate: '1996-09-28',
    gender: 'female',
    bio: 'Dog lover and brunch enthusiast. Looking for my partner in crime!',
    job_title: 'Marketing Manager',
    company: 'Brand Co',
    latitude: 40.7282,
    longitude: -73.7949,
  },
  {
    email: 'frank@example.com',
    password: 'password123',
    name: 'Frank Davis',
    birthdate: '1991-02-14',
    gender: 'male',
    bio: 'Chef by day, gamer by night. Can cook you dinner and beat you at Mario Kart.',
    job_title: 'Head Chef',
    company: 'Fine Dining Restaurant',
    latitude: 40.6892,
    longitude: -74.0445,
  },
  {
    email: 'grace@example.com',
    password: 'password123',
    name: 'Grace Lee',
    birthdate: '1994-12-03',
    gender: 'female',
    bio: 'Artist and bookworm. Looking for someone who appreciates museums and quiet nights in.',
    job_title: 'Graphic Designer',
    company: 'Creative Agency',
    school: 'RISD',
    latitude: 40.7527,
    longitude: -73.9772,
  },
  {
    email: 'henry@example.com',
    password: 'password123',
    name: 'Henry Brown',
    birthdate: '1989-08-21',
    gender: 'male',
    bio: 'Entrepreneur and fitness enthusiast. Looking for someone ambitious and kind.',
    job_title: 'CEO',
    company: 'Brown Ventures',
    latitude: 40.7410,
    longitude: -74.0018,
  },
  {
    email: 'ivy@example.com',
    password: 'password123',
    name: 'Ivy Thompson',
    birthdate: '1998-04-07',
    gender: 'female',
    bio: 'Medical student and dancer. Will definitely challenge you to a dance-off.',
    job_title: 'Medical Student',
    school: 'NYU Medical',
    latitude: 40.7420,
    longitude: -73.9890,
  },
];

/**
 * Sample Unsplash photo URLs for user profile pictures.
 * Uses Unsplash's image resizing service for consistent dimensions.
 */
const SAMPLE_PHOTOS = [
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&h=600&fit=crop',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=600&fit=crop',
  'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400&h=600&fit=crop',
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=600&fit=crop',
  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&h=600&fit=crop',
  'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400&h=600&fit=crop',
  'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=400&h=600&fit=crop',
  'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=400&h=600&fit=crop',
  'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=400&h=600&fit=crop',
  'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&h=600&fit=crop',
];

/**
 * Main seeding function that populates the database with sample data.
 * Clears existing data, creates users with preferences and photos,
 * indexes in Elasticsearch, and creates sample matches with messages.
 */
async function seed() {
  console.log('Starting database seed...');

  try {
    // Clear existing data
    console.log('Clearing existing data...');
    await pool.query('TRUNCATE messages, matches, swipes, photos, user_preferences, users CASCADE');

    // Clear Elasticsearch index
    try {
      await elasticsearch.deleteByQuery({
        index: 'users',
        body: { query: { match_all: {} } },
      });
    } catch (e) {
      // Index might not exist yet
    }

    // Clear Redis
    const keys = await redis.keys('swipes:*');
    const likeKeys = await redis.keys('likes:*');
    const userKeys = await redis.keys('user:*');
    const allKeys = [...keys, ...likeKeys, ...userKeys];
    if (allKeys.length > 0) {
      await redis.del(...allKeys);
    }

    console.log('Creating sample users...');
    const createdUsers: Array<{ id: string; gender: string }> = [];

    for (let i = 0; i < SAMPLE_USERS.length; i++) {
      const user = SAMPLE_USERS[i];
      const passwordHash = await bcrypt.hash(user.password, 10);

      // Create user
      const result = await pool.query(
        `INSERT INTO users (email, password_hash, name, birthdate, gender, bio, job_title, company, school, latitude, longitude, is_admin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, gender`,
        [
          user.email,
          passwordHash,
          user.name,
          user.birthdate,
          user.gender,
          user.bio,
          user.job_title || null,
          user.company || null,
          user.school || null,
          user.latitude,
          user.longitude,
          user.is_admin || false,
        ]
      );

      const userId = result.rows[0].id;
      createdUsers.push({ id: userId, gender: user.gender });

      // Create preferences
      const interestedIn = user.gender === 'male' ? ['female'] : ['male'];
      await pool.query(
        `INSERT INTO user_preferences (user_id, interested_in, age_min, age_max, distance_km, show_me)
         VALUES ($1, $2, 18, 50, 100, true)`,
        [userId, interestedIn]
      );

      // Add photos
      const photoUrl = SAMPLE_PHOTOS[i % SAMPLE_PHOTOS.length];
      await pool.query(
        `INSERT INTO photos (user_id, url, position, is_primary)
         VALUES ($1, $2, 0, true)`,
        [userId, photoUrl]
      );

      // Index in Elasticsearch
      const age = new Date().getFullYear() - new Date(user.birthdate).getFullYear();
      await elasticsearch.index({
        index: 'users',
        id: userId,
        document: {
          id: userId,
          name: user.name,
          gender: user.gender,
          age: age,
          location: {
            lat: user.latitude,
            lon: user.longitude,
          },
          last_active: new Date().toISOString(),
          show_me: true,
          interested_in: interestedIn,
        },
      });

      console.log(`Created user: ${user.name} (${user.email})`);
    }

    // Create some sample swipes and matches
    console.log('Creating sample swipes and matches...');

    // Alice and Bob like each other (match)
    const alice = createdUsers.find((u) => u.gender === 'female');
    const bob = createdUsers.find((u) => u.gender === 'male' && u !== createdUsers[0]);

    if (alice && bob) {
      // Alice likes Bob
      await pool.query(
        `INSERT INTO swipes (swiper_id, swiped_id, direction) VALUES ($1, $2, 'like')`,
        [alice.id, bob.id]
      );
      await redis.sadd(`swipes:${alice.id}:liked`, bob.id);

      // Bob likes Alice
      await pool.query(
        `INSERT INTO swipes (swiper_id, swiped_id, direction) VALUES ($1, $2, 'like')`,
        [bob.id, alice.id]
      );
      await redis.sadd(`swipes:${bob.id}:liked`, alice.id);

      // Create match
      const [first, second] = alice.id < bob.id ? [alice.id, bob.id] : [bob.id, alice.id];
      const matchResult = await pool.query(
        `INSERT INTO matches (user1_id, user2_id) VALUES ($1, $2) RETURNING id`,
        [first, second]
      );

      // Add sample messages
      const matchId = matchResult.rows[0].id;
      await pool.query(
        `INSERT INTO messages (match_id, sender_id, content, sent_at) VALUES
         ($1, $2, 'Hey! Great to match with you!', NOW() - INTERVAL '1 hour'),
         ($1, $3, 'Hi! Likewise! Love your profile!', NOW() - INTERVAL '50 minutes'),
         ($1, $2, 'Thanks! Want to grab coffee sometime?', NOW() - INTERVAL '30 minutes')`,
        [matchId, alice.id, bob.id]
      );

      await pool.query(
        `UPDATE matches SET last_message_at = NOW() - INTERVAL '30 minutes' WHERE id = $1`,
        [matchId]
      );

      console.log('Created match between Alice and Bob with messages');
    }

    console.log('\nSeed completed successfully!');
    console.log('\nTest accounts:');
    console.log('Admin: admin@example.com / admin123');
    console.log('User: alice@example.com / password123');
    console.log('User: bob@example.com / password123');

  } catch (error) {
    console.error('Seed error:', error);
    throw error;
  } finally {
    await pool.end();
    await redis.quit();
    process.exit(0);
  }
}

seed();
