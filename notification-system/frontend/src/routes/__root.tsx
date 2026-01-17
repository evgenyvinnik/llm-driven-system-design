import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';

function RootComponent() {
  const { user, isAuthenticated, logout, checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <Link to="/" className="flex items-center">
                <span className="text-xl font-bold text-indigo-600">NotifyHub</span>
              </Link>
              <div className="hidden md:flex ml-10 space-x-4">
                {isAuthenticated && (
                  <>
                    <Link
                      to="/"
                      className="px-3 py-2 text-sm font-medium text-gray-700 hover:text-indigo-600"
                      activeProps={{ className: 'text-indigo-600' }}
                    >
                      Dashboard
                    </Link>
                    <Link
                      to="/notifications"
                      className="px-3 py-2 text-sm font-medium text-gray-700 hover:text-indigo-600"
                      activeProps={{ className: 'text-indigo-600' }}
                    >
                      Notifications
                    </Link>
                    <Link
                      to="/preferences"
                      className="px-3 py-2 text-sm font-medium text-gray-700 hover:text-indigo-600"
                      activeProps={{ className: 'text-indigo-600' }}
                    >
                      Preferences
                    </Link>
                    {user?.role === 'admin' && (
                      <Link
                        to="/admin"
                        className="px-3 py-2 text-sm font-medium text-gray-700 hover:text-indigo-600"
                        activeProps={{ className: 'text-indigo-600' }}
                      >
                        Admin
                      </Link>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-4">
              {isAuthenticated ? (
                <>
                  <span className="text-sm text-gray-600">
                    {user?.name} ({user?.role})
                  </span>
                  <button
                    onClick={() => logout()}
                    className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-red-600"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <Link
                  to="/login"
                  className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700"
                >
                  Login
                </Link>
              )}
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
