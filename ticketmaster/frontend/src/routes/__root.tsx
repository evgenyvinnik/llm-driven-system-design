import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Header } from '../components/Header';
import { useAuthStore } from '../stores/auth.store';

function RootComponent() {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-ticketmaster-blue"></div>
      </div>
    );
  }

  return (
    <>
      <Header />
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="bg-gray-100 py-6 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center text-gray-500 text-sm">
          Ticketmaster Demo - Event Ticketing Platform
        </div>
      </footer>
    </>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
