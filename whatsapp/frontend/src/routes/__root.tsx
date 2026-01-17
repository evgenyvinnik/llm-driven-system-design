import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';

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

export const Route = createRootRoute({
  component: RootComponent,
});
