/**
 * Root Route Component
 *
 * Top-level route that wraps all other routes.
 * Handles initial authentication check and displays loading state.
 * Provides the outlet for child routes to render.
 */

import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';

/**
 * Root component that checks authentication on mount.
 * Shows a loading spinner while verifying session.
 */
function RootComponent() {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-whatsapp-teal-green">
        <div className="text-center text-white">
          <div className="w-16 h-16 border-4 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-xl">Loading WhatsApp...</p>
        </div>
      </div>
    );
  }

  return <Outlet />;
}

/**
 * Root route configuration for TanStack Router.
 * All other routes are children of this root route.
 */
export const Route = createRootRoute({
  component: RootComponent,
});
