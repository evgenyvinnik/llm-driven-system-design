/**
 * @fileoverview API route definitions for the App Store backend.
 * Organizes routes by domain: auth, catalog, reviews, and developer.
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import * as catalogController from '../controllers/catalogController.js';
import * as reviewController from '../controllers/reviewController.js';
import * as authController from '../controllers/authController.js';
import * as developerController from '../controllers/developerController.js';
import { authenticate, optionalAuth, requireDeveloper } from '../middleware/auth.js';

/** Express router with all API routes */
const router = Router();

// =============================================================================
// Health check (simple version for API)
// =============================================================================
import { simpleHealthCheck } from '../shared/health.js';
router.get('/health', simpleHealthCheck);

// =============================================================================
// Auth routes - User authentication and profile management
// =============================================================================
router.post('/auth/register', asyncHandler(authController.register));
router.post('/auth/login', asyncHandler(authController.login));
router.post('/auth/logout', authenticate, asyncHandler(authController.logout));
router.get('/auth/me', authenticate, asyncHandler(authController.me));
router.put('/auth/profile', authenticate, asyncHandler(authController.updateProfile));
router.post('/auth/change-password', authenticate, asyncHandler(authController.changePassword));
router.post('/auth/become-developer', authenticate, asyncHandler(authController.becomeDeveloper));

// =============================================================================
// Catalog routes (public) - App discovery and browsing
// =============================================================================
router.get('/categories', asyncHandler(catalogController.getCategories));
router.get('/categories/:slug', asyncHandler(catalogController.getCategoryBySlug));
router.get('/apps', asyncHandler(catalogController.getApps));
router.get('/apps/top', asyncHandler(catalogController.getTopApps));
router.get('/apps/search', asyncHandler(catalogController.searchApps));
router.get('/apps/suggest', asyncHandler(catalogController.getSearchSuggestions));
router.get('/apps/:id', asyncHandler(catalogController.getAppById));
router.post('/apps/:id/download', optionalAuth, asyncHandler(catalogController.downloadApp));

// =============================================================================
// Review routes - App reviews and ratings
// =============================================================================
router.get('/apps/:appId/reviews', asyncHandler(reviewController.getReviewsForApp));
router.get('/apps/:appId/ratings', asyncHandler(reviewController.getRatingSummary));
router.post('/apps/:appId/reviews', authenticate, asyncHandler(reviewController.createReview));
router.put('/reviews/:id', authenticate, asyncHandler(reviewController.updateReview));
router.delete('/reviews/:id', authenticate, asyncHandler(reviewController.deleteReview));
router.post('/reviews/:id/vote', authenticate, asyncHandler(reviewController.voteReview));
router.post('/reviews/:id/respond', authenticate, requireDeveloper, asyncHandler(reviewController.respondToReview));

// =============================================================================
// Developer routes - App management for developers
// =============================================================================
router.get('/developer/apps', authenticate, requireDeveloper, asyncHandler(developerController.getDeveloperApps));
router.post('/developer/apps', authenticate, requireDeveloper, asyncHandler(developerController.createApp));
router.put('/developer/apps/:id', authenticate, requireDeveloper, asyncHandler(developerController.updateApp));
router.post('/developer/apps/:id/submit', authenticate, requireDeveloper, asyncHandler(developerController.submitForReview));
router.post('/developer/apps/:id/publish', authenticate, requireDeveloper, asyncHandler(developerController.publishApp));
router.post('/developer/apps/:id/icon', authenticate, requireDeveloper, developerController.uploadMiddleware, asyncHandler(developerController.uploadIcon));
router.post('/developer/apps/:id/screenshots', authenticate, requireDeveloper, developerController.uploadMiddleware, asyncHandler(developerController.uploadScreenshot));
router.delete('/developer/apps/:id/screenshots/:screenshotId', authenticate, requireDeveloper, asyncHandler(developerController.deleteScreenshot));
router.get('/developer/apps/:id/upload-url', authenticate, requireDeveloper, asyncHandler(developerController.getUploadUrl));
router.get('/developer/apps/:id/analytics', authenticate, requireDeveloper, asyncHandler(developerController.getAppAnalytics));
router.get('/developer/apps/:id/reviews', authenticate, requireDeveloper, asyncHandler(developerController.getAppReviews));

export default router;
