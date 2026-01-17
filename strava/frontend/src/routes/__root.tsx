import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Navbar } from '../components/Navbar';
import { useAuthStore } from '../stores/authStore';

function RootComponent() {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-strava-gray-50 flex items-center justify-center">
        <div className="text-xl text-strava-gray-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-strava-gray-50">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
