import { query } from './index.js';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

const seed = async () => {
  console.log('Seeding database...');

  try {
    // Create test users
    const passwordHash = await bcrypt.hash('password123', 10);

    const users = [
      { username: 'admin', email: 'admin@reddit.local', role: 'admin' },
      { username: 'alice', email: 'alice@reddit.local', role: 'user' },
      { username: 'bob', email: 'bob@reddit.local', role: 'user' },
      { username: 'charlie', email: 'charlie@reddit.local', role: 'user' },
      { username: 'diana', email: 'diana@reddit.local', role: 'user' },
    ];

    for (const user of users) {
      await query(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING`,
        [user.username, user.email, passwordHash, user.role]
      );
    }
    console.log('Created test users');

    // Get user IDs
    const { rows: userRows } = await query('SELECT id, username FROM users');
    const userMap = {};
    for (const row of userRows) {
      userMap[row.username] = row.id;
    }

    // Create subreddits
    const subreddits = [
      { name: 'programming', title: 'Programming', description: 'All things programming and software development' },
      { name: 'javascript', title: 'JavaScript', description: 'JavaScript discussions and news' },
      { name: 'webdev', title: 'Web Development', description: 'Frontend, backend, and everything in between' },
      { name: 'askreddit', title: 'Ask Reddit', description: 'Ask and answer thought-provoking questions' },
      { name: 'technology', title: 'Technology', description: 'Technology news and discussions' },
    ];

    for (const sub of subreddits) {
      await query(
        `INSERT INTO subreddits (name, title, description, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO NOTHING`,
        [sub.name, sub.title, sub.description, userMap.admin]
      );
    }
    console.log('Created subreddits');

    // Get subreddit IDs
    const { rows: subRows } = await query('SELECT id, name FROM subreddits');
    const subMap = {};
    for (const row of subRows) {
      subMap[row.name] = row.id;
    }

    // Create subscriptions
    for (const username of ['admin', 'alice', 'bob', 'charlie', 'diana']) {
      for (const subName of ['programming', 'javascript', 'webdev']) {
        await query(
          `INSERT INTO subscriptions (user_id, subreddit_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [userMap[username], subMap[subName]]
        );
      }
    }

    // Update subscriber counts
    await query(`
      UPDATE subreddits s
      SET subscriber_count = (
        SELECT COUNT(*) FROM subscriptions WHERE subreddit_id = s.id
      )
    `);
    console.log('Created subscriptions');

    // Create sample posts
    const posts = [
      { subreddit: 'programming', author: 'alice', title: 'What is your favorite programming language and why?', content: 'I\'ve been programming for 5 years and I\'m curious what everyone prefers. Personally I love TypeScript for its type safety while maintaining JavaScript flexibility.' },
      { subreddit: 'programming', author: 'bob', title: 'Just learned about recursion - mind blown!', content: 'Today I finally understood recursion. It\'s like looking into a mirror that reflects another mirror. The key is the base case!' },
      { subreddit: 'javascript', author: 'charlie', title: 'React 19 is amazing - here\'s why', content: 'The new React compiler and server components are game changers. No more useCallback and useMemo everywhere!' },
      { subreddit: 'javascript', author: 'diana', title: 'TypeScript tips for beginners', content: 'Start with strict mode from day one. Use interfaces for objects, types for unions. And please, avoid `any` like the plague.' },
      { subreddit: 'webdev', author: 'alice', title: 'CSS Grid vs Flexbox - when to use which?', content: 'Grid for 2D layouts (rows AND columns), Flexbox for 1D (either rows OR columns). That\'s the simple rule I follow.' },
      { subreddit: 'askreddit', author: 'bob', title: 'What\'s a programming concept that took you forever to understand?', content: 'For me it was async/await. I kept thinking it made things synchronous, but it\'s really about managing asynchronous operations more elegantly.' },
      { subreddit: 'technology', author: 'charlie', title: 'AI coding assistants - helpful or harmful?', content: 'I\'ve been using Copilot for 6 months now. It\'s great for boilerplate but you still need to understand what it generates.' },
    ];

    for (const post of posts) {
      const now = new Date();
      // Calculate initial hot score
      const epochSeconds = 1134028003;
      const seconds = Math.floor(now.getTime() / 1000) - epochSeconds;
      const hotScore = seconds / 45000;

      await query(
        `INSERT INTO posts (subreddit_id, author_id, title, content, hot_score)
         VALUES ($1, $2, $3, $4, $5)`,
        [subMap[post.subreddit], userMap[post.author], post.title, post.content, hotScore]
      );
    }
    console.log('Created sample posts');

    // Get post IDs
    const { rows: postRows } = await query('SELECT id, title FROM posts ORDER BY id');

    // Create sample comments
    const comments = [
      { postIndex: 0, author: 'bob', content: 'TypeScript is great! I switched from Java and never looked back.' },
      { postIndex: 0, author: 'charlie', content: 'Python for data science, Rust for systems programming, TypeScript for web. Each tool has its place.' },
      { postIndex: 1, author: 'alice', content: 'Wait until you learn about tail recursion optimization!' },
      { postIndex: 2, author: 'bob', content: 'I\'m still on React 18. Is the migration difficult?' },
      { postIndex: 2, author: 'alice', content: 'Not too bad actually. Most breaking changes are in the lesser-used APIs.' },
      { postIndex: 3, author: 'charlie', content: 'Great tips! I\'d add: always use readonly where possible.' },
    ];

    for (const comment of comments) {
      const postId = postRows[comment.postIndex].id;
      // Insert the comment to get its ID
      const { rows } = await query(
        `INSERT INTO comments (post_id, author_id, content, path, depth)
         VALUES ($1, $2, $3, '', 0)
         RETURNING id`,
        [postId, userMap[comment.author], comment.content]
      );
      // Update the path with the comment ID
      await query(
        `UPDATE comments SET path = $1 WHERE id = $2`,
        [rows[0].id.toString(), rows[0].id]
      );
    }

    // Add nested replies
    const { rows: commentRows } = await query('SELECT id, post_id FROM comments ORDER BY id');

    // Reply to first comment
    const reply1Result = await query(
      `INSERT INTO comments (post_id, author_id, parent_id, content, path, depth)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [commentRows[0].post_id, userMap.diana, commentRows[0].id, 'Same here! TypeScript\'s type inference is amazing.', '', 1]
    );
    await query(
      `UPDATE comments SET path = $1 WHERE id = $2`,
      [`${commentRows[0].id}.${reply1Result.rows[0].id}`, reply1Result.rows[0].id]
    );

    // Reply to the reply
    const reply2Result = await query(
      `INSERT INTO comments (post_id, author_id, parent_id, content, path, depth)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [commentRows[0].post_id, userMap.alice, reply1Result.rows[0].id, 'The generics took me a while to fully grasp though.', '', 2]
    );
    await query(
      `UPDATE comments SET path = $1 WHERE id = $2`,
      [`${commentRows[0].id}.${reply1Result.rows[0].id}.${reply2Result.rows[0].id}`, reply2Result.rows[0].id]
    );

    // Update comment counts
    await query(`
      UPDATE posts p
      SET comment_count = (
        SELECT COUNT(*) FROM comments WHERE post_id = p.id
      )
    `);
    console.log('Created sample comments');

    // Create sample votes
    const voteData = [
      // Votes on posts
      { user: 'bob', postIndex: 0, direction: 1 },
      { user: 'charlie', postIndex: 0, direction: 1 },
      { user: 'diana', postIndex: 0, direction: 1 },
      { user: 'alice', postIndex: 1, direction: 1 },
      { user: 'charlie', postIndex: 1, direction: 1 },
      { user: 'diana', postIndex: 1, direction: -1 },
      { user: 'alice', postIndex: 2, direction: 1 },
      { user: 'bob', postIndex: 2, direction: 1 },
      { user: 'diana', postIndex: 2, direction: 1 },
      { user: 'alice', postIndex: 3, direction: 1 },
      { user: 'bob', postIndex: 3, direction: 1 },
    ];

    for (const vote of voteData) {
      const postId = postRows[vote.postIndex].id;
      await query(
        `INSERT INTO votes (user_id, post_id, direction)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userMap[vote.user], postId, vote.direction]
      );
    }

    // Aggregate votes to posts
    await query(`
      UPDATE posts p
      SET
        upvotes = COALESCE((SELECT COUNT(*) FROM votes WHERE post_id = p.id AND direction = 1), 0),
        downvotes = COALESCE((SELECT COUNT(*) FROM votes WHERE post_id = p.id AND direction = -1), 0),
        score = COALESCE((SELECT SUM(direction) FROM votes WHERE post_id = p.id), 0)
    `);

    // Recalculate hot scores
    const epochSeconds = 1134028003;
    await query(`
      UPDATE posts
      SET hot_score = (
        CASE
          WHEN score > 0 THEN 1
          WHEN score < 0 THEN -1
          ELSE 0
        END * LOG(GREATEST(ABS(score), 1))
        + EXTRACT(EPOCH FROM created_at - '2005-12-08 07:46:43'::timestamp) / 45000
      )
    `);

    // Update user karma
    await query(`
      UPDATE users u
      SET karma_post = COALESCE((
        SELECT SUM(p.score) FROM posts p WHERE p.author_id = u.id
      ), 0)
    `);

    console.log('Created sample votes and updated scores');

    console.log('Database seeded successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Seeding failed:', error);
    process.exit(1);
  }
};

seed();
