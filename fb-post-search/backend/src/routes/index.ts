/**
 * @fileoverview Main API router combining all route modules.
 * Mounts search, auth, posts, and admin routes under /api/v1.
 */

import { Router } from 'express';
import searchRoutes from './search.js';
import authRoutes from './auth.js';
import postRoutes from './posts.js';
import adminRoutes from './admin.js';

/**
 * Combined API router.
 * Mounts all route modules under their respective paths.
 */
const router = Router();

router.use('/search', searchRoutes);
router.use('/auth', authRoutes);
router.use('/posts', postRoutes);
router.use('/admin', adminRoutes);

export default router;
