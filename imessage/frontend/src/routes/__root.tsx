import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '@/stores/authStore';

/**
 * Root component that wraps all routes.
 * Initiates authentication check on app load to restore user session
 * from persisted token if available.
 *
 * @returns React component that renders child routes via Outlet
 */
function RootComponent() {
  const checkAuth = useAuthStore((state) => state.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return <Outlet />;
}

/**
 * Root route configuration for TanStack Router.
 * Defines the top-level route that wraps all other routes.
 */
export const Route = createRootRoute({
  component: RootComponent,
});
