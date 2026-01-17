/**
 * @fileoverview Database seeding script for development and testing.
 * Populates the database with sample users, friendships, and posts.
 * Also indexes all posts in Elasticsearch for immediate searchability.
 */

import { pool } from '../config/database.js';
import { esClient, POSTS_INDEX, initializeElasticsearch } from '../config/elasticsearch.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import type { Visibility, PostType, PostDocument } from '../types/index.js';

/**
 * Hashes a password using SHA-256.
 * Note: Use bcrypt in production for secure password hashing.
 * @param password - Plain text password to hash
 * @returns Hexadecimal hash string
 */
function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Generates visibility fingerprints for privacy-aware search filtering.
 * These fingerprints are stored in Elasticsearch and matched against user visibility sets.
 * @param authorId - The post author's user ID
 * @param visibility - The post's visibility setting
 * @param friendIds - Array of the author's friend IDs (used for friends_of_friends)
 * @returns Array of fingerprint strings (e.g., ['PUBLIC'], ['FRIENDS:userId'])
 */
function generateVisibilityFingerprints(
  authorId: string,
  visibility: Visibility,
  friendIds: string[]
): string[] {
  const fingerprints: string[] = [];

  if (visibility === 'public') {
    fingerprints.push('PUBLIC');
  }

  if (visibility === 'friends' || visibility === 'friends_of_friends') {
    // Author's friends can see
    fingerprints.push(`FRIENDS:${authorId}`);
  }

  if (visibility === 'private') {
    // Only the author
    fingerprints.push(`PRIVATE:${authorId}`);
  }

  return fingerprints;
}

/**
 * Extracts hashtags from post content.
 * @param content - Post content text
 * @returns Array of lowercase hashtags including the # prefix
 */
function extractHashtags(content: string): string[] {
  const regex = /#(\w+)/g;
  const matches = content.match(regex);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

/**
 * Extracts user mentions from post content.
 * @param content - Post content text
 * @returns Array of lowercase mentions including the @ prefix
 */
function extractMentions(content: string): string[] {
  const regex = /@(\w+)/g;
  const matches = content.match(regex);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

/**
 * Sample user data for seeding the database.
 * Includes regular users and one admin account.
 */
const sampleUsers = [
  { username: 'alice', email: 'alice@example.com', display_name: 'Alice Johnson', password: 'password123' },
  { username: 'bob', email: 'bob@example.com', display_name: 'Bob Smith', password: 'password123' },
  { username: 'carol', email: 'carol@example.com', display_name: 'Carol Williams', password: 'password123' },
  { username: 'david', email: 'david@example.com', display_name: 'David Brown', password: 'password123' },
  { username: 'eve', email: 'eve@example.com', display_name: 'Eve Davis', password: 'password123' },
  { username: 'frank', email: 'frank@example.com', display_name: 'Frank Miller', password: 'password123' },
  { username: 'grace', email: 'grace@example.com', display_name: 'Grace Wilson', password: 'password123' },
  { username: 'henry', email: 'henry@example.com', display_name: 'Henry Taylor', password: 'password123' },
  { username: 'admin', email: 'admin@example.com', display_name: 'System Admin', password: 'admin123', role: 'admin' },
];

/**
 * Sample posts with varied content, visibility settings, and post types.
 * Contains hashtags for testing hashtag search and filtering.
 */
const samplePosts: { content: string; visibility: Visibility; post_type: PostType }[] = [
  { content: 'Just had an amazing birthday party! Thanks everyone for coming! #birthday #party #celebration', visibility: 'public', post_type: 'text' },
  { content: 'Working on a new machine learning project. The results are promising! #ml #ai #tech', visibility: 'public', post_type: 'text' },
  { content: 'Beautiful sunset at the beach today. Nature is amazing! #sunset #beach #nature #photography', visibility: 'public', post_type: 'photo' },
  { content: 'Finally finished reading that book everyone was talking about. Highly recommend! #books #reading', visibility: 'friends', post_type: 'text' },
  { content: 'Cooked a delicious pasta dinner tonight. #food #cooking #pasta #homemade', visibility: 'public', post_type: 'photo' },
  { content: 'Starting a new fitness journey! Who wants to join? #fitness #health #motivation', visibility: 'public', post_type: 'text' },
  { content: 'Movie night with friends! Watching the new sci-fi thriller. #movies #scifi #friends', visibility: 'friends', post_type: 'text' },
  { content: 'Just adopted a cute puppy! Meet Max! #puppy #dog #adoption #cute', visibility: 'public', post_type: 'photo' },
  { content: 'Learning TypeScript and it\'s amazing! The type safety is so helpful. #typescript #programming #webdev', visibility: 'public', post_type: 'text' },
  { content: 'Coffee and coding - the perfect Saturday morning. #coffee #coding #weekend', visibility: 'public', post_type: 'photo' },
  { content: 'Happy to announce I got the job! Dreams do come true! #newjob #career #excited', visibility: 'friends', post_type: 'text' },
  { content: 'Exploring the mountains this weekend. The view is breathtaking! #hiking #mountains #adventure #nature', visibility: 'public', post_type: 'photo' },
  { content: 'Can\'t believe it\'s already December. Where did the year go? #time #reflection', visibility: 'friends', post_type: 'text' },
  { content: 'Just deployed my first Kubernetes cluster. DevOps is fun! #kubernetes #devops #cloud', visibility: 'public', post_type: 'text' },
  { content: 'Throwback to last summer\'s road trip. Best vacation ever! #throwback #travel #roadtrip', visibility: 'public', post_type: 'photo' },
  { content: 'Made homemade pizza for the first time. Not too bad! #pizza #cooking #firsttime', visibility: 'friends', post_type: 'photo' },
  { content: 'The concert last night was incredible! Still can\'t believe I saw them live! #concert #music #livemusic', visibility: 'public', post_type: 'video' },
  { content: 'Rainy day calls for a good book and hot chocolate. #rain #cozy #reading', visibility: 'friends', post_type: 'text' },
  { content: 'Just finished a 10K run! Personal best time! #running #fitness #personalrecord', visibility: 'public', post_type: 'text' },
  { content: 'Celebrating 5 years at the company today. Time flies! #workanniversary #grateful', visibility: 'friends', post_type: 'text' },
  { content: 'The kids had so much fun at the birthday party. Thanks to all the parents! #kids #birthday #parenting', visibility: 'friends', post_type: 'photo' },
  { content: 'New blog post about system design interviews. Link in bio! #systemdesign #interview #tech', visibility: 'public', post_type: 'link' },
  { content: 'Just tried the new restaurant downtown. The food was amazing! #restaurant #foodie #dinner', visibility: 'public', post_type: 'photo' },
  { content: 'Finally upgraded my home office setup. So much more productive now! #homeoffice #productivity #wfh', visibility: 'friends', post_type: 'photo' },
  { content: 'Happy Friday everyone! What are your weekend plans? #friday #weekend #tgif', visibility: 'public', post_type: 'text' },
];

/**
 * Main seeding function that populates the database with sample data.
 * - Initializes Elasticsearch index
 * - Clears existing data from all tables
 * - Creates sample users with hashed passwords
 * - Creates bidirectional friendships (Alice and Bob are friends with everyone)
 * - Creates sample posts with randomized authors and engagement metrics
 * - Bulk indexes all posts in Elasticsearch
 */
async function seed() {
  console.log('Seeding database...');

  try {
    // Initialize Elasticsearch
    await initializeElasticsearch();

    // Clear existing data
    await pool.query('DELETE FROM search_history');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM friendships');
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM users');

    // Clear Elasticsearch index
    try {
      await esClient.deleteByQuery({
        index: POSTS_INDEX,
        body: {
          query: { match_all: {} },
        },
      });
    } catch {
      // Index might not exist yet
    }

    // Insert users
    const userIds: string[] = [];
    for (const user of sampleUsers) {
      const result = await pool.query(
        `INSERT INTO users (username, email, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [user.username, user.email, user.display_name, hashPassword(user.password), user.role || 'user']
      );
      userIds.push(result.rows[0].id);
    }
    console.log(`Created ${userIds.length} users`);

    // Create friendships (everyone is friends with Alice and Bob for demo purposes)
    const friendships: [string, string][] = [];
    for (let i = 2; i < userIds.length - 1; i++) {
      friendships.push([userIds[0], userIds[i]]); // Alice friends with everyone
      friendships.push([userIds[1], userIds[i]]); // Bob friends with everyone
    }
    // Alice and Bob are friends
    friendships.push([userIds[0], userIds[1]]);

    for (const [userId, friendId] of friendships) {
      await pool.query(
        `INSERT INTO friendships (user_id, friend_id, status)
         VALUES ($1, $2, 'accepted')`,
        [userId, friendId]
      );
      // Bidirectional friendship
      await pool.query(
        `INSERT INTO friendships (user_id, friend_id, status)
         VALUES ($1, $2, 'accepted')`,
        [friendId, userId]
      );
    }
    console.log(`Created ${friendships.length * 2} friendships`);

    // Insert posts and index in Elasticsearch
    const userDisplayNames: Record<string, string> = {};
    for (let i = 0; i < sampleUsers.length; i++) {
      userDisplayNames[userIds[i]] = sampleUsers[i].display_name;
    }

    const postDocuments: PostDocument[] = [];
    for (const postData of samplePosts) {
      const authorIndex = Math.floor(Math.random() * (userIds.length - 1)); // Exclude admin
      const authorId = userIds[authorIndex];

      // Get author's friends for visibility fingerprints
      const friendResult = await pool.query(
        `SELECT friend_id FROM friendships WHERE user_id = $1 AND status = 'accepted'`,
        [authorId]
      );
      const friendIds = friendResult.rows.map((r) => r.friend_id);

      const postId = uuidv4();
      const now = new Date();
      // Randomize creation date within last 30 days
      const createdAt = new Date(now.getTime() - Math.random() * 30 * 24 * 60 * 60 * 1000);

      const likeCount = Math.floor(Math.random() * 100);
      const commentCount = Math.floor(Math.random() * 50);
      const shareCount = Math.floor(Math.random() * 20);

      await pool.query(
        `INSERT INTO posts (id, author_id, content, visibility, post_type, like_count, comment_count, share_count, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [postId, authorId, postData.content, postData.visibility, postData.post_type, likeCount, commentCount, shareCount, createdAt]
      );

      // Prepare Elasticsearch document
      const fingerprints = generateVisibilityFingerprints(authorId, postData.visibility, friendIds);

      postDocuments.push({
        post_id: postId,
        author_id: authorId,
        author_name: userDisplayNames[authorId],
        content: postData.content,
        hashtags: extractHashtags(postData.content),
        mentions: extractMentions(postData.content),
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
        visibility: postData.visibility,
        visibility_fingerprints: fingerprints,
        post_type: postData.post_type,
        engagement_score: likeCount * 1 + commentCount * 2 + shareCount * 3,
        like_count: likeCount,
        comment_count: commentCount,
        share_count: shareCount,
        language: 'en',
      });
    }

    // Bulk index posts in Elasticsearch
    const operations = postDocuments.flatMap((doc) => [
      { index: { _index: POSTS_INDEX, _id: doc.post_id } },
      doc,
    ]);

    await esClient.bulk({ refresh: true, operations });
    console.log(`Created and indexed ${postDocuments.length} posts`);

    console.log('Seeding completed successfully!');
    console.log('\nSample login credentials:');
    console.log('  User: alice / password123');
    console.log('  User: bob / password123');
    console.log('  Admin: admin / admin123');
  } catch (error) {
    console.error('Seeding failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
