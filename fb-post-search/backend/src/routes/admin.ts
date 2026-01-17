/**
 * @fileoverview Admin API routes.
 * Defines endpoints for administrative operations. All routes require admin role.
 */

import { Router } from 'express';
import * as adminController from '../controllers/adminController.js';
import { requireAdmin } from '../middleware/auth.js';

/**
 * Express router for admin-only endpoints.
 * Base path: /api/v1/admin
 * All routes are protected by requireAdmin middleware.
 */
const router = Router();

// All admin routes require admin authentication
router.use(requireAdmin);

// GET /api/v1/admin/stats - System statistics
router.get('/stats', adminController.getStats);

// GET /api/v1/admin/users - List all users
router.get('/users', adminController.getUsers);

// GET /api/v1/admin/posts - List all posts
router.get('/posts', adminController.getPosts);

// GET /api/v1/admin/search-history - View search history
router.get('/search-history', adminController.getSearchHistory);

// POST /api/v1/admin/reindex - Reindex all posts in Elasticsearch
router.post('/reindex', adminController.reindexPosts);

// GET /api/v1/admin/health - Health check
router.get('/health', adminController.healthCheck);

export default router;
