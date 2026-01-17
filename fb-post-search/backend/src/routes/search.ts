/**
 * @fileoverview Search API routes.
 * Defines endpoints for full-text search, suggestions, trending, and history.
 */

import { Router } from 'express';
import * as searchController from '../controllers/searchController.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';

/**
 * Express router for search-related endpoints.
 * Base path: /api/v1/search
 */
const router = Router();

// POST /api/v1/search - Main search endpoint
router.post('/', optionalAuth, searchController.search);

// GET /api/v1/search/suggestions - Typeahead suggestions
router.get('/suggestions', optionalAuth, searchController.suggestions);

// GET /api/v1/search/trending - Trending searches
router.get('/trending', searchController.trending);

// GET /api/v1/search/filters - Available filter options
router.get('/filters', searchController.getFilters);

// GET /api/v1/search/recent - User's recent searches (requires auth)
router.get('/recent', requireAuth, searchController.recentSearches);

// DELETE /api/v1/search/history - Clear user's search history
router.delete('/history', requireAuth, searchController.clearHistory);

export default router;
