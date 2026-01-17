/**
 * Root route component for the application.
 * Handles initial auth check and provides the base layout.
 * @module routes/__root
 */
import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Layout } from '../components/Layout';
import { useAuthStore } from '../stores/authStore';
import { useEffect } from 'react';

/**
 * Root component that wraps all pages.
 * Checks authentication state on mount and shows loading spinner.
 * Provides Layout wrapper for child routes.
 */
function RootComponent() {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
