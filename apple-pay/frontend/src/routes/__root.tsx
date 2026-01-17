/**
 * Root route component for the Apple Pay frontend.
 * Handles session recovery on app load by checking for existing session.
 */
import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores';

/** Root route configuration - wraps all child routes */
export const Route = createRootRoute({
  component: RootComponent,
});

/**
 * Root component that wraps the entire application.
 * Attempts to load user from stored session on mount.
 *
 * @returns The router Outlet for rendering child routes
 */
function RootComponent() {
  const { loadUser } = useAuthStore();

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  return <Outlet />;
}
