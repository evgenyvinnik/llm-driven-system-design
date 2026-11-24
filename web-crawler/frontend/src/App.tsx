import { useEffect } from 'react';
import { Outlet } from '@tanstack/react-router';
import { Header } from './components/Header';
import { useAuthStore } from './stores/authStore';

export function App() {
  const checkSession = useAuthStore((s) => s.checkSession);

  // Restore "who am I" from the session cookie once per page load
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-7xl mx-auto">
        <Outlet />
      </main>
    </div>
  );
}
