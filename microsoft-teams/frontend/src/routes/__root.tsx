import { createRootRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';

// Pages a signed-out visitor may stay on.
const PUBLIC_PATHS = ['/login', '/register'];

function RootComponent() {
  const { user, loading, checkAuth } = useAuthStore();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Only bounce signed-out visitors off private pages. This used to redirect
  // every page, so opening /register directly (or reloading it) always landed
  // on the login form.
  useEffect(() => {
    if (!loading && !user && !PUBLIC_PATHS.includes(pathname)) {
      navigate({ to: '/login' });
    }
  }, [loading, user, pathname, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-teams-bg">
        <div className="text-teams-secondary text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-teams-bg">
      <Outlet />
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
