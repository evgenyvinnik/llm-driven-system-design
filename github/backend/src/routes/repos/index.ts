/**
 * Repository Routes Module
 *
 * @description Aggregates all repository-related route handlers into a single router.
 * This module serves as the main entry point for repository API endpoints, mounting
 * sub-routers for different repository operations.
 *
 * @module routes/repos
 */
import { Router } from 'express';
import listRoutes from './list.js';
import readRoutes from './read.js';
import crudRoutes from './crud.js';
import collaboratorsRoutes from './collaborators.js';
import branchesRoutes from './branches.js';
import contentsRoutes from './contents.js';
import settingsRoutes from './settings.js';

/**
 * Express router for repository endpoints.
 * Mounts all repository-related sub-routers.
 */
const router = Router();

// Mount all repository-related routes
// List repositories (GET /)
router.use(listRoutes);

// Get single repository (GET /:owner/:repo)
router.use(readRoutes);

// CRUD operations (create, update, delete)
router.use(crudRoutes);

// Collaborator operations (star, unstar, check starred)
router.use(collaboratorsRoutes);

// Branch and tag operations
router.use(branchesRoutes);

// File and tree content operations
router.use(contentsRoutes);

// Settings and webhook operations
router.use(settingsRoutes);

export default router;

// Re-export types for consumers
export * from './types.js';
