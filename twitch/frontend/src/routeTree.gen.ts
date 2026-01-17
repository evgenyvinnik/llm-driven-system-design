import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { RootLayout } from '../components/RootLayout';
import { HomePage } from '../components/HomePage';
import { BrowsePage } from '../components/BrowsePage';
import { CategoryPage } from '../components/CategoryPage';
import { ChannelPage } from '../components/ChannelPage';
import { FollowingPage } from '../components/FollowingPage';
import { DashboardPage } from '../components/DashboardPage';

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});

const browseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/browse',
  component: BrowsePage,
});

const categoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/category/$slug',
  component: CategoryPage,
});

const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$channelName',
  component: ChannelPage,
});

const followingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/following',
  component: FollowingPage,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: DashboardPage,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  browseRoute,
  categoryRoute,
  followingRoute,
  dashboardRoute,
  channelRoute, // Must be last due to dynamic param
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
