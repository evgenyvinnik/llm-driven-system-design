import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  searchPosts,
  getSearchSuggestions,
  getUserRecentSearches,
  getTrendingSearches,
  deleteSearchHistory,
} from '../services/searchService.js';
import type { SearchRequest, SearchFilters, PostType, Visibility } from '../types/index.js';

// POST /api/v1/search
export async function search(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { query, filters, pagination } = req.body;

    if (!query && !filters) {
      res.status(400).json({ error: 'Query or filters required' });
      return;
    }

    const searchRequest: SearchRequest = {
      query: query || '',
      filters: filters as SearchFilters,
      pagination: {
        cursor: pagination?.cursor,
        limit: Math.min(pagination?.limit || 20, 100),
      },
      user_id: req.userId,
    };

    const results = await searchPosts(searchRequest);
    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
}

// GET /api/v1/search/suggestions
export async function suggestions(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { q, limit } = req.query;

    if (!q || typeof q !== 'string') {
      res.status(400).json({ error: 'Query parameter "q" required' });
      return;
    }

    const suggestions = await getSearchSuggestions(
      q,
      req.userId,
      Math.min(parseInt(String(limit) || '10', 10), 20)
    );

    res.json({ suggestions });
  } catch (error) {
    console.error('Suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
}

// GET /api/v1/search/recent
export async function recentSearches(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { limit } = req.query;
    const searches = await getUserRecentSearches(
      req.userId,
      Math.min(parseInt(String(limit) || '10', 10), 50)
    );

    res.json({ searches });
  } catch (error) {
    console.error('Recent searches error:', error);
    res.status(500).json({ error: 'Failed to get recent searches' });
  }
}

// GET /api/v1/search/trending
export async function trending(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { limit } = req.query;
    const searches = await getTrendingSearches(
      Math.min(parseInt(String(limit) || '10', 10), 50)
    );

    res.json({ trending: searches });
  } catch (error) {
    console.error('Trending searches error:', error);
    res.status(500).json({ error: 'Failed to get trending searches' });
  }
}

// DELETE /api/v1/search/history
export async function clearHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    await deleteSearchHistory(req.userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Clear history error:', error);
    res.status(500).json({ error: 'Failed to clear history' });
  }
}

// GET /api/v1/search/filters
export async function getFilters(_req: AuthenticatedRequest, res: Response): Promise<void> {
  // Return available filter options
  const filters = {
    post_types: ['text', 'photo', 'video', 'link'] as PostType[],
    visibility_options: ['public', 'friends', 'friends_of_friends', 'private'] as Visibility[],
    sort_options: [
      { value: 'relevance', label: 'Most Relevant' },
      { value: 'recent', label: 'Most Recent' },
      { value: 'engagement', label: 'Most Engagement' },
    ],
  };

  res.json(filters);
}
