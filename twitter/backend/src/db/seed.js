import pool from './pool.js';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

async function seed() {
  console.log('Seeding database with test data...');

  try {
    // Clear existing data
    await pool.query('TRUNCATE users, tweets, follows, likes, retweets, hashtag_activity RESTART IDENTITY CASCADE');

    // Create test users
    const passwordHash = await bcrypt.hash('password123', 10);

    const usersData = [
      { username: 'alice', email: 'alice@example.com', display_name: 'Alice Johnson', bio: 'Tech enthusiast and coffee lover' },
      { username: 'bob', email: 'bob@example.com', display_name: 'Bob Smith', bio: 'Developer by day, gamer by night' },
      { username: 'charlie', email: 'charlie@example.com', display_name: 'Charlie Brown', bio: 'Music is life' },
      { username: 'diana', email: 'diana@example.com', display_name: 'Diana Ross', bio: 'Travel blogger and photographer' },
      { username: 'eve', email: 'eve@example.com', display_name: 'Eve Williams', bio: 'Startup founder | AI enthusiast' },
      { username: 'frank', email: 'frank@example.com', display_name: 'Frank Miller', bio: 'Sports commentator' },
      { username: 'grace', email: 'grace@example.com', display_name: 'Grace Lee', bio: 'Food critic and chef' },
      { username: 'admin', email: 'admin@example.com', display_name: 'Admin User', bio: 'Platform administrator', role: 'admin' },
    ];

    const userIds = [];
    for (const user of usersData) {
      const result = await pool.query(
        `INSERT INTO users (username, email, password_hash, display_name, bio, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [user.username, user.email, passwordHash, user.display_name, user.bio, user.role || 'user']
      );
      userIds.push(result.rows[0].id);
    }

    console.log(`Created ${userIds.length} users`);

    // Create follow relationships
    const followPairs = [
      [0, 1], [0, 2], [0, 3], [0, 4], // Alice follows bob, charlie, diana, eve
      [1, 0], [1, 2], [1, 4], // Bob follows alice, charlie, eve
      [2, 0], [2, 1], [2, 3], [2, 5], // Charlie follows alice, bob, diana, frank
      [3, 0], [3, 4], [3, 6], // Diana follows alice, eve, grace
      [4, 0], [4, 1], [4, 2], [4, 3], [4, 5], [4, 6], // Eve follows many
      [5, 0], [5, 2], // Frank follows alice, charlie
      [6, 0], [6, 3], [6, 4], // Grace follows alice, diana, eve
    ];

    for (const [followerIdx, followingIdx] of followPairs) {
      await pool.query(
        `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)`,
        [userIds[followerIdx], userIds[followingIdx]]
      );
    }

    console.log(`Created ${followPairs.length} follow relationships`);

    // Create sample tweets
    const tweetsData = [
      { author: 0, content: 'Just started learning about distributed systems! #coding #learning' },
      { author: 1, content: 'Weekend gaming session was epic! #gaming #weekend' },
      { author: 2, content: 'New album dropping next week! Stay tuned #music #newrelease' },
      { author: 3, content: 'Exploring the beautiful streets of Tokyo #travel #japan #photography' },
      { author: 4, content: 'Excited to announce our Series A funding! #startup #tech #announcement' },
      { author: 0, content: 'Coffee and code - the perfect morning combo #developer #coffee' },
      { author: 1, content: 'Anyone else excited for the new game release? #gaming' },
      { author: 5, content: 'What a match last night! The comeback was incredible #sports #live' },
      { author: 6, content: 'Just tried the new restaurant downtown. Amazing sushi! #food #review' },
      { author: 3, content: 'Sunset at Mount Fuji - absolutely breathtaking #travel #nature #japan' },
      { author: 4, content: 'Building the future one line of code at a time #tech #innovation' },
      { author: 0, content: 'Finally deployed my first microservice! #kubernetes #devops' },
      { author: 2, content: 'Thank you all for 100k streams! You are amazing #music #milestone' },
      { author: 6, content: 'Recipe of the day: homemade pasta with truffle sauce #cooking #recipe' },
      { author: 1, content: 'Pro tip: always save your game before boss fights #gaming #tips' },
    ];

    const tweetIds = [];
    for (const tweet of tweetsData) {
      // Extract hashtags from content
      const hashtags = tweet.content.match(/#\w+/g)?.map(h => h.toLowerCase().slice(1)) || [];

      const result = await pool.query(
        `INSERT INTO tweets (author_id, content, hashtags)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [userIds[tweet.author], tweet.content, hashtags]
      );
      tweetIds.push(result.rows[0].id);

      // Record hashtag activity
      for (const hashtag of hashtags) {
        await pool.query(
          `INSERT INTO hashtag_activity (hashtag, tweet_id) VALUES ($1, $2)`,
          [hashtag, result.rows[0].id]
        );
      }
    }

    console.log(`Created ${tweetIds.length} tweets`);

    // Create some likes
    const likePairs = [
      [0, 1], [0, 2], [0, 4], // Alice likes bob's tweet, charlie's, eve's
      [1, 0], [1, 3], [1, 4], // Bob likes alice's, diana's, eve's
      [2, 0], [2, 5], // Charlie likes alice's tweets
      [3, 8], [3, 13], // Diana likes grace's food tweets
      [4, 0], [4, 11], // Eve likes alice's tech tweets
      [5, 7], // Frank likes his own sports tweet (narcissist!)
      [6, 3], [6, 9], // Grace likes travel tweets
    ];

    for (const [userIdx, tweetIdx] of likePairs) {
      await pool.query(
        `INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)`,
        [userIds[userIdx], tweetIds[tweetIdx]]
      );
    }

    console.log(`Created ${likePairs.length} likes`);

    // Create some retweets
    const retweetPairs = [
      [0, 4], // Alice retweets eve's announcement
      [1, 0], // Bob retweets alice's first tweet
      [4, 11], // Eve retweets alice's kubernetes tweet
    ];

    for (const [userIdx, tweetIdx] of retweetPairs) {
      await pool.query(
        `INSERT INTO retweets (user_id, tweet_id) VALUES ($1, $2)`,
        [userIds[userIdx], tweetIds[tweetIdx]]
      );
    }

    console.log(`Created ${retweetPairs.length} retweets`);

    console.log('Seed completed successfully!');
    console.log('\nTest accounts:');
    console.log('  Username: alice, bob, charlie, diana, eve, frank, grace, admin');
    console.log('  Password: password123');

  } catch (error) {
    console.error('Seed failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
