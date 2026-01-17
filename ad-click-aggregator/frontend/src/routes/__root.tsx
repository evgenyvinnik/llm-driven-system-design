/**
 * @fileoverview Root layout component for the application.
 * Provides the base structure with navigation and content outlet.
 */

import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Navigation } from '../components/Navigation'

/**
 * Root route definition for TanStack Router.
 */
export const Route = createRootRoute({
  component: RootLayout,
})

/**
 * Root layout wrapper that provides consistent page structure.
 * Renders navigation and an outlet for child route content.
 *
 * @returns Layout container with navigation and content area
 */
function RootLayout() {
  return (
    <div className="min-h-screen bg-gray-100">
      <Navigation />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
