/**
 * Orders route aggregator module.
 * @module routes/orders
 * @description Combines all order-related route modules into a single router.
 * This is the main entry point for the /orders API endpoints.
 *
 * Route mounting order is important to avoid path conflicts:
 * 1. Order creation (POST /)
 * 2. Restaurant orders (/restaurant/:restaurantId) - before /:id to avoid conflict
 * 3. Status updates (/:id/status)
 * 4. Order retrieval (/ and /:id)
 */

import { Router } from 'express';
import createRouter from './create.js';
import getRouter from './get.js';
import statusRouter from './status.js';
import restaurantRouter from './restaurant.js';

const router = Router();

/**
 * Order creation routes.
 * @description Mounts POST /orders endpoint for creating new orders.
 */
router.use('/', createRouter);

/**
 * Restaurant order routes.
 * @description Mounts GET /orders/restaurant/:restaurantId endpoint.
 * Must be mounted before get router to avoid conflict with /:id route.
 */
router.use('/', restaurantRouter);

/**
 * Order status update routes.
 * @description Mounts PATCH /orders/:id/status endpoint for status transitions.
 */
router.use('/', statusRouter);

/**
 * Order retrieval routes.
 * @description Mounts GET /orders and GET /orders/:id endpoints.
 */
router.use('/', getRouter);

/**
 * Combined orders router.
 * @description Exports the aggregated router with all order endpoints:
 * - POST /orders - Create a new order
 * - GET /orders - List customer's orders
 * - GET /orders/:id - Get single order details
 * - GET /orders/restaurant/:restaurantId - Get restaurant's orders
 * - PATCH /orders/:id/status - Update order status
 */
export default router;
