/**
 * @fileoverview Navigation header component for the web crawler dashboard.
 *
 * Provides the main navigation bar with links to all dashboard views:
 * - Dashboard: Real-time stats and overview
 * - Frontier: URL queue management
 * - Pages: Browse crawled content
 * - Domains: Domain-level statistics
 * - Admin: Administrative actions
 *
 * Uses TanStack Router for navigation with active state styling.
 *
 * @module components/Header
 */

import { Link, useLocation } from '@tanstack/react-router';

/**
 * Navigation header with links to all dashboard views.
 *
 * Displays the application logo, name, and navigation links.
 * Highlights the currently active route.
 *
 * @returns React component rendering the header navigation
 *
 * @example
 * ```tsx
 * import { Header } from './components/Header';
 *
 * function App() {
 *   return (
 *     <div>
 *       <Header />
 *       <main>...</main>
 *     </div>
 *   );
 * }
 * ```
 */
export function Header() {
  const location = useLocation();

  /**
   * Navigation items with path and label.
   */
  const navItems = [
    { path: '/', label: 'Dashboard' },
    { path: '/frontier', label: 'Frontier' },
    { path: '/pages', label: 'Pages' },
    { path: '/domains', label: 'Domains' },
    { path: '/admin', label: 'Admin' },
  ];

  return (
    <header className="bg-white shadow-sm border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            <svg
              className="h-8 w-8 text-primary-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
              />
            </svg>
            <span className="ml-2 text-xl font-semibold text-gray-900">Web Crawler</span>
          </div>

          <nav className="flex space-x-1">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-primary-100 text-primary-700'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </header>
  );
}
