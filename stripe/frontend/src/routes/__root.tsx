/**
 * Root Route Layout
 *
 * The root layout component that wraps all pages in the application.
 * Handles authentication state and conditionally renders either the
 * login form or the main dashboard layout with sidebar navigation.
 *
 * @module routes/__root
 */

import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useMerchantStore } from '@/stores';
import { Sidebar, LoginForm } from '@/components';

/**
 * Root route definition for TanStack Router.
 * All other routes are nested under this layout.
 */
export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * Root layout component.
 * Checks authentication status and renders either:
 * - LoginForm for unauthenticated users
 * - Sidebar + page content for authenticated merchants
 *
 * @returns The appropriate layout based on auth state
 */
function RootLayout() {
  const { apiKey } = useMerchantStore();

  // Show login form if no API key is stored
  if (!apiKey) {
    return <LoginForm />;
  }

  // Render authenticated dashboard layout
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
