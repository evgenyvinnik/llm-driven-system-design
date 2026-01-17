import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Navbar } from '../components/Navbar';
import { useAuthStore } from '../stores/authStore';
import { useEffect } from 'react';

function RootComponent() {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-linkedin-blue"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-linkedin-gray">
      <Navbar />
      <Outlet />
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
