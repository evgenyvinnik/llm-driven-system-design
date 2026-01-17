import { query, queryOne, execute } from '../db/postgres.js';
import { v4 as uuid } from 'uuid';

interface User {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  created_at: Date;
}

interface UserPreferences {
  preferred_topics: string[];
  preferred_sources: string[];
  blocked_sources: string[];
}

interface ReadingHistoryEntry {
  article_id: string;
  article_title: string;
  story_id: string | null;
  read_at: Date;
  dwell_time_seconds: number;
}

// Simple password hashing (use bcrypt in production)
function hashPassword(password: string): string {
  // In production, use bcrypt.hash()
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(password + 'salt').digest('hex');
}

function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

/**
 * Create a new user
 */
export async function createUser(
  username: string,
  email: string,
  password: string
): Promise<User> {
  const id = uuid();
  const passwordHash = hashPassword(password);

  await execute(
    `INSERT INTO users (id, username, email, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [id, username, email, passwordHash]
  );

  // Initialize preferences
  await execute(
    `INSERT INTO user_preferences (user_id)
     VALUES ($1)`,
    [id]
  );

  return {
    id,
    username,
    email,
    role: 'user',
    created_at: new Date(),
  };
}

/**
 * Authenticate a user
 */
export async function authenticateUser(
  email: string,
  password: string
): Promise<User | null> {
  const user = await queryOne<User & { password_hash: string }>(
    'SELECT id, username, email, password_hash, role, created_at FROM users WHERE email = $1',
    [email]
  );

  if (!user || !verifyPassword(password, user.password_hash)) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
  };
}

/**
 * Get user by ID
 */
export async function getUserById(id: string): Promise<User | null> {
  return queryOne<User>(
    'SELECT id, username, email, role, created_at FROM users WHERE id = $1',
    [id]
  );
}

/**
 * Get user preferences
 */
export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const prefs = await queryOne<UserPreferences>(
    'SELECT preferred_topics, preferred_sources, blocked_sources FROM user_preferences WHERE user_id = $1',
    [userId]
  );

  return prefs || {
    preferred_topics: [],
    preferred_sources: [],
    blocked_sources: [],
  };
}

/**
 * Update user preferences
 */
export async function updateUserPreferences(
  userId: string,
  updates: Partial<UserPreferences>
): Promise<UserPreferences> {
  const current = await getUserPreferences(userId);

  const newPrefs = {
    preferred_topics: updates.preferred_topics ?? current.preferred_topics,
    preferred_sources: updates.preferred_sources ?? current.preferred_sources,
    blocked_sources: updates.blocked_sources ?? current.blocked_sources,
  };

  await execute(
    `INSERT INTO user_preferences (user_id, preferred_topics, preferred_sources, blocked_sources)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       preferred_topics = $2,
       preferred_sources = $3,
       blocked_sources = $4,
       updated_at = NOW()`,
    [userId, newPrefs.preferred_topics, newPrefs.preferred_sources, newPrefs.blocked_sources]
  );

  return newPrefs;
}

/**
 * Record that a user read an article
 */
export async function recordArticleRead(
  userId: string,
  articleId: string,
  dwellTimeSeconds: number = 0
): Promise<void> {
  // Get article's story ID
  const article = await queryOne<{ story_id: string | null; topics: string[] }>(
    'SELECT story_id, topics FROM articles WHERE id = $1',
    [articleId]
  );

  if (!article) {
    throw new Error('Article not found');
  }

  // Record reading history
  await execute(
    `INSERT INTO user_reading_history (user_id, article_id, story_id, dwell_time_seconds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, article_id) DO UPDATE SET
       dwell_time_seconds = user_reading_history.dwell_time_seconds + $4,
       read_at = NOW()`,
    [userId, articleId, article.story_id, dwellTimeSeconds]
  );

  // Update topic weights based on reading behavior
  for (const topic of article.topics) {
    // Increase weight based on dwell time
    const weightIncrease = dwellTimeSeconds > 60 ? 0.1 : 0.05;

    await execute(
      `INSERT INTO user_topic_weights (user_id, topic, weight)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, topic) DO UPDATE SET
         weight = LEAST(user_topic_weights.weight + $3, 1.0)`,
      [userId, topic, weightIncrease]
    );
  }
}

/**
 * Get user's reading history
 */
export async function getReadingHistory(
  userId: string,
  limit: number = 50
): Promise<ReadingHistoryEntry[]> {
  return query<ReadingHistoryEntry>(
    `SELECT urh.article_id, a.title as article_title, urh.story_id, urh.read_at, urh.dwell_time_seconds
     FROM user_reading_history urh
     JOIN articles a ON urh.article_id = a.id
     WHERE urh.user_id = $1
     ORDER BY urh.read_at DESC
     LIMIT $2`,
    [userId, limit]
  );
}

/**
 * Get all available topics
 */
export async function getAvailableTopics(): Promise<string[]> {
  const result = await query<{ topic: string }>(
    `SELECT DISTINCT unnest(topics) as topic FROM stories
     WHERE created_at > NOW() - INTERVAL '7 days'
     ORDER BY topic`,
    []
  );

  return result.map(r => r.topic);
}
