import { createRootRoute, Outlet, Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '@/stores/authStore';

function RootComponent() {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-tiktok-dark">
        <div className="spinner"></div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-tiktok-dark">
      <Outlet />
      <BottomNav />
    </div>
  );
}

function BottomNav() {
  const { isAuthenticated, user } = useAuthStore();

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-black border-t border-gray-800 z-50">
      <div className="flex justify-around items-center h-14 max-w-lg mx-auto">
        <Link
          to="/"
          className="flex flex-col items-center text-xs"
          activeProps={{ className: 'text-white' }}
          inactiveProps={{ className: 'text-gray-500' }}
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
          </svg>
          <span>Home</span>
        </Link>

        <Link
          to="/discover"
          className="flex flex-col items-center text-xs"
          activeProps={{ className: 'text-white' }}
          inactiveProps={{ className: 'text-gray-500' }}
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <span>Discover</span>
        </Link>

        {isAuthenticated && (
          <Link
            to="/upload"
            className="flex flex-col items-center text-xs"
          >
            <div className="w-10 h-7 bg-gradient-to-r from-tiktok-blue to-tiktok-red rounded flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </div>
          </Link>
        )}

        <Link
          to="/inbox"
          className="flex flex-col items-center text-xs"
          activeProps={{ className: 'text-white' }}
          inactiveProps={{ className: 'text-gray-500' }}
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
          </svg>
          <span>Inbox</span>
        </Link>

        {isAuthenticated ? (
          <Link
            to="/profile/$username"
            params={{ username: user?.username || '' }}
            className="flex flex-col items-center text-xs"
            activeProps={{ className: 'text-white' }}
            inactiveProps={{ className: 'text-gray-500' }}
          >
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.displayName}
                className="w-6 h-6 rounded-full"
              />
            ) : (
              <div className="w-6 h-6 rounded-full bg-gray-600 flex items-center justify-center text-xs">
                {user?.displayName?.[0]?.toUpperCase() || 'U'}
              </div>
            )}
            <span>Me</span>
          </Link>
        ) : (
          <Link
            to="/login"
            className="flex flex-col items-center text-xs"
            activeProps={{ className: 'text-white' }}
            inactiveProps={{ className: 'text-gray-500' }}
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
            <span>Login</span>
          </Link>
        )}
      </div>
    </nav>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
