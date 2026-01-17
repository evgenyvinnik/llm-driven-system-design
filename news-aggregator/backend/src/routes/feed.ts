/**
 * Feed API routes.
 * Provides endpoints for retrieving news feeds, stories, and search functionality.
 * Supports personalized feeds, topic filtering, breaking news, and trending content.
 * @module routes/feed
 */

import { Router, Request, Response } from 'express';
import {
  getPersonalizedFeed,
  getTopicFeed,
  getBreakingNews,
  getTrendingStories,
  getStory,
} from '../services/feed.js';
import { query } from '../db/postgres.js';
import { searchArticles } from '../db/elasticsearch.js';

const router = Router();

/**
 * GET /feed - Get personalized news feed
 * Returns stories ranked by relevance, freshness, quality, and trending signals.
 * Authenticated users receive personalized rankings based on their preferences.
 */
router.get('/feed', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as { userId?: string })?.userId || null;
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    const feed = await getPersonalizedFeed(userId, cursor || null, limit);
    res.json(feed);
  } catch (error) {
    console.error('Error fetching feed:', error);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

/**
 * GET /feed/topic/:topic - Get feed filtered by topic
 * Returns stories matching the specified topic, ordered by velocity and recency.
 */
router.get('/feed/topic/:topic', async (req: Request, res: Response) => {
  try {
    const { topic } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    const feed = await getTopicFeed(topic, cursor || null, limit);
    res.json(feed);
  } catch (error) {
    console.error('Error fetching topic feed:', error);
    res.status(500).json({ error: 'Failed to fetch topic feed' });
  }
});

/**
 * GET /breaking - Get breaking news stories
 * Returns stories marked as breaking or with high velocity (> 0.5 articles/min).
 */
router.get('/breaking', async (_req: Request, res: Response) => {
  try {
    const stories = await getBreakingNews(10);
    res.json({ stories });
  } catch (error) {
    console.error('Error fetching breaking news:', error);
    res.status(500).json({ error: 'Failed to fetch breaking news' });
  }
});

/**
 * GET /trending - Get trending stories
 * Returns stories with the most article coverage in the last 24 hours.
 */
router.get('/trending', async (_req: Request, res: Response) => {
  try {
    const stories = await getTrendingStories(10);
    res.json({ stories });
  } catch (error) {
    console.error('Error fetching trending stories:', error);
    res.status(500).json({ error: 'Failed to fetch trending stories' });
  }
});

/**
 * GET /stories/:id - Get a single story with all its articles
 * Returns full story details including up to 20 article sources.
 */
router.get('/stories/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const story = await getStory(id);

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    res.json(story);
  } catch (error) {
    console.error('Error fetching story:', error);
    res.status(500).json({ error: 'Failed to fetch story' });
  }
});

/**
 * GET /stories/:id/articles - Get articles for a story
 * Returns articles belonging to the specified story with source information.
 */
router.get('/stories/:id/articles', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;

    const articles = await query(
      `SELECT a.id, a.source_id, s.name as source_name, a.title, a.summary, a.url,
              a.author, a.published_at, a.topics
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.story_id = $1
       ORDER BY a.published_at DESC
       LIMIT $2`,
      [id, limit]
    );

    res.json({ articles });
  } catch (error) {
    console.error('Error fetching story articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

/**
 * GET /search - Search articles
 * Full-text search across article titles, summaries, and bodies.
 * Supports filtering by topics and date range.
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const topics = req.query.topics
      ? (req.query.topics as string).split(',')
      : undefined;
    const dateFrom = req.query.date_from
      ? new Date(req.query.date_from as string)
      : undefined;
    const dateTo = req.query.date_to
      ? new Date(req.query.date_to as string)
      : undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    // Search in Elasticsearch
    const searchResults = await searchArticles(q, {
      topics,
      dateFrom,
      dateTo,
      limit,
    });

    if (searchResults.length === 0) {
      return res.json({ articles: [] });
    }

    // Get full article details from PostgreSQL
    const articleIds = searchResults.map(r => r.id);
    const articles = await query(
      `SELECT a.id, a.source_id, s.name as source_name, a.title, a.summary, a.url,
              a.author, a.published_at, a.topics, a.story_id
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.id = ANY($1)`,
      [articleIds]
    );

    // Preserve search result order
    const articleMap = new Map((articles as { id: string }[]).map((a) => [a.id, a]));
    const orderedArticles = articleIds
      .map(id => articleMap.get(id))
      .filter(Boolean);

    res.json({ articles: orderedArticles });
  } catch (error) {
    console.error('Error searching articles:', error);
    res.status(500).json({ error: 'Failed to search articles' });
  }
});

/**
 * GET /topics - Get available topics with story counts
 * Returns topics from recent stories, sorted by popularity.
 */
router.get('/topics', async (_req: Request, res: Response) => {
  try {
    const result = await query<{ topic: string; count: number }>(
      `SELECT topic, count FROM (
         SELECT unnest(topics) as topic, COUNT(*) as count
         FROM stories
         WHERE created_at > NOW() - INTERVAL '7 days'
         GROUP BY unnest(topics)
       ) t
       ORDER BY count DESC
       LIMIT 20`,
      []
    );

    res.json({ topics: result });
  } catch (error) {
    console.error('Error fetching topics:', error);
    res.status(500).json({ error: 'Failed to fetch topics' });
  }
});

export default router;
