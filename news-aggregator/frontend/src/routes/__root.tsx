/**
 * Root layout component for the application.
 * Wraps all pages with header navigation and main content area.
 * @module routes/__root
 */

import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '../components';

/**
 * Root route configuration.
 * Provides consistent layout with header and centered content area.
 */
export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  ),
});
