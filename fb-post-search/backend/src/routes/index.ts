import { Router } from 'express';
import searchRoutes from './search.js';
import authRoutes from './auth.js';
import postRoutes from './posts.js';
import adminRoutes from './admin.js';

const router = Router();

router.use('/search', searchRoutes);
router.use('/auth', authRoutes);
router.use('/posts', postRoutes);
router.use('/admin', adminRoutes);

export default router;
