import { createRootRoute, Outlet, Navigate, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores';
import { Layout } from '../components/Layout';

function RootComponent() {
  const { isAuthenticated, isLoading, checkAuth } = useAuthStore();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-split-bg flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-split-green mx-auto" />
          <p className="mt-4 text-split-ink-soft">Loading…</p>
        </div>
      </div>
    );
  }

  const isAuthPage = pathname === '/login' || pathname === '/register';

  if (!isAuthenticated && !isAuthPage) return <Navigate to="/login" />;
  if (isAuthenticated && isAuthPage) return <Navigate to="/" />;

  if (isAuthPage) return <Outlet />;

  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
