/**
 * Application router configuration using TanStack Router.
 * Defines all routes and their component mappings.
 * @module router
 */

import { createRouter, createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { DashboardPage } from './routes/Dashboard';
import { JobsPage } from './routes/Jobs';
import { JobDetailPage } from './routes/JobDetail';
import { ExecutionDetailPage } from './routes/ExecutionDetail';
import { WorkersPage } from './routes/Workers';

/** Root route wrapping all pages in the Layout component */
const rootRoute = createRootRoute({
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
});

/** Dashboard route - system overview at root path */
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

/** Jobs list route - paginated job management */
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  component: JobsPage,
});

/** Job detail route - single job view with executions */
const jobDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs/$jobId',
  component: JobDetailPage,
});

/** Execution detail route - single execution with logs */
const executionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/executions/$executionId',
  component: ExecutionDetailPage,
});

/** Workers route - worker status monitoring */
const workersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workers',
  component: WorkersPage,
});

/** Complete route tree with all application routes */
const routeTree = rootRoute.addChildren([
  dashboardRoute,
  jobsRoute,
  jobDetailRoute,
  executionDetailRoute,
  workersRoute,
]);

/** Configured router instance for the application */
export const router = createRouter({ routeTree });

/** Type declarations for TanStack Router type safety */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
