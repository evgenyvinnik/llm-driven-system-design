/**
 * Main layout component with navigation bar.
 * Provides consistent page structure with navigation and content area,
 * and gates the whole dashboard behind an authenticated session.
 * @module components/Layout
 */

import { useEffect } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useAuthStore } from '../stores';
import { LoginPage } from '../routes/Login';
import { Spinner } from './UI';

/**
 * Application layout wrapper with navigation.
 *
 * Every /api/v1 endpoint requires a session, so the layout owns the auth gate:
 * it restores the session on mount and renders the login screen until one
 * exists. The gate keys off `authChecked` rather than `user` alone — checking
 * only `user` would show the login form for a split second on every reload,
 * before the session-restore request has had a chance to answer.
 *
 * @param children - Page content to render in the main area
 */
export function Layout({ children }: { children: React.ReactNode }) {
  const router = useRouterState();
  const currentPath = router.location.pathname;
  const { user, authChecked, checkSession, logout } = useAuthStore();

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const navItems = [
    { path: '/', label: 'Dashboard' },
    { path: '/jobs', label: 'Jobs' },
    { path: '/workers', label: 'Workers' },
  ];

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <span className="text-xl font-bold text-gray-900">
                  Job Scheduler
                </span>
              </div>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                {navItems.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium ${
                      currentPath === item.path
                        ? 'border-blue-500 text-gray-900'
                        : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600">
                {user.username}
                <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                  {user.role}
                </span>
              </span>
              <button
                onClick={() => void logout()}
                className="text-sm text-gray-500 hover:text-gray-900"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
