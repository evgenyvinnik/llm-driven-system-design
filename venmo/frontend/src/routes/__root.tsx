import { createRootRoute, Outlet, Navigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores';
import { Layout } from '../components/Layout';

function RootComponent() {
  const { isAuthenticated, isLoading, checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-venmo-light flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-venmo-blue mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Redirect to login if not authenticated (except for login/register pages)
  const isAuthPage = window.location.pathname === '/login' || window.location.pathname === '/register';

  if (!isAuthenticated && !isAuthPage) {
    return <Navigate to="/login" />;
  }

  if (isAuthenticated && isAuthPage) {
    return <Navigate to="/" />;
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
