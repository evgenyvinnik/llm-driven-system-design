/**
 * Application Entry Point
 *
 * Initializes the React application with:
 * - StrictMode for development warnings
 * - TanStack Router for client-side routing
 *
 * The router is configured with the auto-generated route tree
 * from the routes/ directory.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './index.css';

/** Create the router instance with the generated route tree */
const router = createRouter({ routeTree });

/**
 * TypeScript module augmentation for type-safe router access.
 * Enables autocomplete and type checking for route paths.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
