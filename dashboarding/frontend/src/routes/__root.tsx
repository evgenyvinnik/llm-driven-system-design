/**
 * @fileoverview Root layout component for the application.
 *
 * Provides the base layout structure with navigation bar and alert banner
 * that wraps all child routes.
 */

import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Navbar } from '../components/Navbar';
import { AlertBanner } from '../components/AlertBanner';

/**
 * Root route configuration for TanStack Router.
 */
export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * Root layout component that wraps all pages.
 *
 * Provides consistent page structure with:
 * - Navigation bar at the top
 * - Alert banner for firing alerts
 * - Main content area via Outlet
 *
 * @returns The rendered layout
 */
function RootLayout() {
  return (
    <div className="min-h-screen bg-dashboard-bg">
      <Navbar />
      <AlertBanner />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
