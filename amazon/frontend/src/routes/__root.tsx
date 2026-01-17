import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '../components/Header';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';

function RootComponent() {
  const { checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <div className="min-h-screen bg-gray-100">
      <Header />
      <main>
        <Outlet />
      </main>
      <footer className="bg-slate-800 text-white py-8 mt-12">
        <div className="max-w-7xl mx-auto px-4 text-center text-sm text-gray-400">
          <p>Amazon Clone - System Design Learning Project</p>
          <p className="mt-2">Built with React, TypeScript, and Express</p>
        </div>
      </footer>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
