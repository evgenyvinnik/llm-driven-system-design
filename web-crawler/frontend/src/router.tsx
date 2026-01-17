import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { App } from './App';
import { Dashboard } from './routes/Dashboard';
import { Frontier } from './routes/Frontier';
import { Pages } from './routes/Pages';
import { Domains } from './routes/Domains';
import { Admin } from './routes/Admin';

// Root route
const rootRoute = createRootRoute({
  component: App,
});

// Dashboard route
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Dashboard,
});

// Frontier route
const frontierRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/frontier',
  component: Frontier,
});

// Pages route
const pagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pages',
  component: Pages,
});

// Domains route
const domainsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/domains',
  component: Domains,
});

// Admin route
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: Admin,
});

// Route tree
const routeTree = rootRoute.addChildren([
  dashboardRoute,
  frontierRoute,
  pagesRoute,
  domainsRoute,
  adminRoute,
]);

// Create router
export const router = createRouter({ routeTree });

// Type safety for router
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
