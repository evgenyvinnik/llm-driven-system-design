/**
 * Root route layout component.
 * Provides the main application shell with header and content area.
 */

import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '../components/Header';

/** Root route definition */
export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * Root layout component that wraps all pages.
 * Renders the header and an outlet for child routes.
 */
function RootLayout() {
  return (
    <div className="min-h-screen bg-robinhood-darker flex flex-col">
      <Header />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
