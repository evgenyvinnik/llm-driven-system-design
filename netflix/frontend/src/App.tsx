import React from 'react';
import { createRouter, createRoute, createRootRoute, RouterProvider, Outlet, redirect } from '@tanstack/react-router';
import { useAuthStore } from './stores/authStore';
import {
  LoginPage,
  ProfilesPage,
  BrowsePage,
  VideoDetailPage,
  WatchPage,
  SearchPage,
  MyListPage,
} from './routes';

// Root route
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

// Login route
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

// Register route (uses login page for now)
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: LoginPage,
});

// Profiles route
const profilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profiles',
  component: ProfilesPage,
});

// Add profile route
const addProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profiles/add',
  component: ProfilesPage, // Reuse profiles page for now
});

// Browse route
const browseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/browse',
  component: BrowsePage,
});

// Browse series route
const browseSeriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/browse/series',
  component: BrowsePage,
});

// Browse movies route
const browseMoviesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/browse/movies',
  component: BrowsePage,
});

// Video detail route
const videoDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/video/$videoId',
  component: VideoDetailPage,
});

// Watch route
const watchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/watch/$videoId',
  component: WatchPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      episodeId: (search.episodeId as string) || undefined,
    };
  },
});

// Search route
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      q: (search.q as string) || '',
    };
  },
});

// My List route
const myListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/my-list',
  component: MyListPage,
});

// Index route - redirects to browse or login
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    // Check auth status and redirect
    const { isAuthenticated, currentProfile } = useAuthStore.getState();
    if (!isAuthenticated) {
      throw redirect({ to: '/login' });
    }
    if (!currentProfile) {
      throw redirect({ to: '/profiles' });
    }
    throw redirect({ to: '/browse' });
  },
  component: () => null,
});

// Create router
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  profilesRoute,
  addProfileRoute,
  browseRoute,
  browseSeriesRoute,
  browseMoviesRoute,
  videoDetailRoute,
  watchRoute,
  searchRoute,
  myListRoute,
]);

const router = createRouter({ routeTree });

// Register router for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  const { checkAuth, isLoading } = useAuthStore();

  React.useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-netflix-black flex items-center justify-center">
        <div className="w-16 h-16 border-4 border-netflix-red border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <RouterProvider router={router} />;
}
