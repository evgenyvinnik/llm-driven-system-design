import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Navbar } from '../components/Navbar';

// Root layout
const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  ),
});

// Dashboard/Home
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => import('./Dashboard').then((m) => <m.Dashboard />),
});

// Login
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: () => import('./Login').then((m) => <m.Login />),
});

// Register
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: () => import('./Register').then((m) => <m.Register />),
});

// Metrics
const metricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/metrics',
  component: () => import('./Metrics').then((m) => <m.Metrics />),
});

// Devices
const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/devices',
  component: () => import('./Devices').then((m) => <m.Devices />),
});

// Admin
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: () => import('./Admin').then((m) => <m.Admin />),
});

// Build route tree
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  metricsRoute,
  devicesRoute,
  adminRoute,
]);

// Create router
export const router = createRouter({ routeTree });

// Type registration
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
