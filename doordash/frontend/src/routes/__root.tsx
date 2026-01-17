import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Header } from '../components/Header';

/**
 * Root route configuration for the application.
 * Defines the root layout that wraps all child routes.
 */
export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * Root layout component that provides the application shell.
 * Renders the header and a main content area where child routes are displayed.
 *
 * This layout is applied to all pages in the application, providing
 * consistent navigation and styling.
 *
 * @returns React component with header and outlet for child routes
 */
function RootLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
