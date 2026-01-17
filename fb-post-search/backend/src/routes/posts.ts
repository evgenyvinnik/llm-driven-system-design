/**
 * @fileoverview Post API routes.
 * Defines endpoints for post CRUD operations, feed, and likes.
 */

import { Router } from 'express';
import * as postController from '../controllers/postController.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';

/**
 * Express router for post-related endpoints.
 * Base path: /api/v1/posts
 */
const router = Router();

// POST /api/v1/posts - Create a new post
router.post('/', requireAuth, postController.create);

// GET /api/v1/posts/feed - Get user's feed
router.get('/feed', requireAuth, postController.getFeed);

// GET /api/v1/posts/user/:userId - Get posts by user
router.get('/user/:userId', optionalAuth, postController.getByUser);

// GET /api/v1/posts/:id - Get post by ID
router.get('/:id', optionalAuth, postController.getById);

// PUT /api/v1/posts/:id - Update post
router.put('/:id', requireAuth, postController.update);

// DELETE /api/v1/posts/:id - Delete post
router.delete('/:id', requireAuth, postController.remove);

// POST /api/v1/posts/:id/like - Like a post
router.post('/:id/like', requireAuth, postController.like);

export default router;
