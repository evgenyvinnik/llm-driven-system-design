import { Suspense, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Navbar } from './Navbar';

/** App shell: restores the session once, renders the navbar, and shows lazily loaded pages. */
export function RootLayout() {
  const { checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <div className="min-h-screen bg-dark-400">
      <Navbar />
      <Suspense
        fallback={
          <div className="flex items-center justify-center min-h-[calc(100vh-64px)]">
            <div className="animate-spin w-8 h-8 border-2 border-current border-t-transparent text-primary-500 rounded-full"></div>
          </div>
        }
      >
        <Outlet />
      </Suspense>
    </div>
  );
}
