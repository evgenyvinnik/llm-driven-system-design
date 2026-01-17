/**
 * Root route component for TanStack Router.
 * Renders child routes via Outlet.
 * @module routes/__root
 */

import { createRootRoute, Outlet } from '@tanstack/react-router';

/** Root route that wraps all child routes with Outlet */
export const Route = createRootRoute({
  component: () => <Outlet />,
});
