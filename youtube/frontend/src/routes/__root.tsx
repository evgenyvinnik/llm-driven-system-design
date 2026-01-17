import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import { useAuthStore } from '../stores/authStore';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <div className="min-h-screen bg-yt-dark text-white">
      <Header />
      <div className="flex pt-14">
        <Sidebar />
        <main className="flex-1 ml-60 min-h-[calc(100vh-3.5rem)]">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
