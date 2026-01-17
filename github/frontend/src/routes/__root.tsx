import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Header } from '../components/Header';
import { useAuthStore } from '../stores/authStore';

function RootComponent() {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-github-bg flex items-center justify-center">
        <div className="text-github-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-github-bg">
      <Header />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
