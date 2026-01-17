import { createRouter, createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { DashboardPage } from './routes/Dashboard';
import { JobsPage } from './routes/Jobs';
import { JobDetailPage } from './routes/JobDetail';
import { ExecutionDetailPage } from './routes/ExecutionDetail';
import { WorkersPage } from './routes/Workers';

// Root route
const rootRoute = createRootRoute({
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
});

// Dashboard route
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

// Jobs list route
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  component: JobsPage,
});

// Job detail route
const jobDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs/$jobId',
  component: JobDetailPage,
});

// Execution detail route
const executionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/executions/$executionId',
  component: ExecutionDetailPage,
});

// Workers route
const workersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workers',
  component: WorkersPage,
});

// Route tree
const routeTree = rootRoute.addChildren([
  dashboardRoute,
  jobsRoute,
  jobDetailRoute,
  executionDetailRoute,
  workersRoute,
]);

// Router
export const router = createRouter({ routeTree });

// Type declarations
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
