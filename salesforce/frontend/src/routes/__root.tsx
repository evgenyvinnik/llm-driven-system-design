import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Sidebar } from '../components/Sidebar';

function RootComponent() {
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (loading) {
    return (
      <div className="min-h-screen bg-salesforce-bg flex items-center justify-center">
        <div className="text-salesforce-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-salesforce-bg">
      {user && <Sidebar />}
      <main className={user ? 'ml-56' : ''}>
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
