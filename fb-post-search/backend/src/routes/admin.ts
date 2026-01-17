import { Router } from 'express';
import * as adminController from '../controllers/adminController.js';
import { requireAdmin } from '../middleware/auth.js';

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
