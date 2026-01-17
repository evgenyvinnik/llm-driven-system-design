/**
 * @fileoverview TanStack Router configuration.
 *
 * Assembles the application route tree and creates the router instance.
 * Registers TypeScript types for router-aware components.
 */

import { createRouter } from '@tanstack/react-router';
import { Route as RootRoute } from './routes/__root';
import { Route as IndexRoute } from './routes/index';
import { Route as DashboardRoute } from './routes/dashboard.$dashboardId';
import { Route as AlertsRoute } from './routes/alerts';
import { Route as MetricsRoute } from './routes/metrics';

/**
 * Application route tree with all page routes as children of the root layout.
 */
const routeTree = RootRoute.addChildren([
  IndexRoute,
  DashboardRoute,
  AlertsRoute,
  MetricsRoute,
]);

/**
 * The application router instance.
 * Export for use in main.tsx and router-aware hooks.
 */
export const router = createRouter({ routeTree });

/**
 * Type registration for TanStack Router.
 * Enables type-safe navigation and route params throughout the app.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
