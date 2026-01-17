/**
 * Application entry point.
 * Sets up React with TanStack Router for client-side routing.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import './index.css';

// Import the generated route tree
import { routeTree } from './routeTree.gen';

/**
 * Create the router instance with the generated route tree.
 * TanStack Router uses file-based routing with code generation.
 */
const router = createRouter({ routeTree });

/**
 * Register the router instance for TypeScript type safety.
 * This enables type-safe navigation and route parameters throughout the app.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/**
 * Mount the React application to the DOM.
 * StrictMode enables additional development checks.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
