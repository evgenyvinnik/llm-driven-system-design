/**
 * @fileoverview Application entry point.
 * Initializes React with TanStack Router for client-side routing.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './index.css';

/** TanStack Router instance configured with generated route tree */
const router = createRouter({ routeTree });

/**
 * Type registration for TanStack Router.
 * Enables type-safe navigation throughout the app.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Render the application
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
