import { createRootRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import Header from '../components/Header';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { user, loading, checkAuth, logout } = useAuthStore();
  const [searchQuery, setSearchQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate({ to: '/', search: { q: searchQuery.trim() } });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-confluence-bg">
        <div className="text-confluence-text-subtle">Loading...</div>
      </div>
    );
  }

  return (
    <>
      <Header
        user={user}
        onLogout={logout}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchSubmit={handleSearch}
      />
      <div className="flex-1">
        <Outlet />
      </div>
      {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
    </>
  );
}
