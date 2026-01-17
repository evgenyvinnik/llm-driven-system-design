/**
 * @fileoverview Root route layout component.
 * Wraps all pages with header, main content area, and footer.
 */

import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '../components/Header';

/** Root route definition with layout component */
export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * Root layout component.
 * Provides consistent page structure across all routes.
 */
function RootLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main>
        <Outlet />
      </main>
      <footer className="bg-white border-t border-gray-200 mt-12 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center text-gray-500 text-sm">
            <p>App Store - A learning project for system design</p>
            <p className="mt-1">Built with React, Express, PostgreSQL, and Elasticsearch</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
