/**
 * @fileoverview Root route component for TanStack Router.
 * Provides the application layout shell with header and main content area.
 */

import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Header } from '../components/Header';
import { useAuthStore } from '../stores/authStore';

/**
 * Root layout component that wraps all routes.
 * Checks authentication state on mount and displays loading state until ready.
 */
function RootComponent() {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-pulse text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

/**
 * TanStack Router root route definition.
 * All other routes are children of this root route.
 */
export const Route = createRootRoute({
  component: RootComponent,
});
