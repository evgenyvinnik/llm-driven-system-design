/**
 * Application Entry Point
 *
 * Initializes the React application with TanStack Router.
 * Sets up the router with the generated route tree and renders
 * the application into the DOM root element.
 *
 * @module main
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './index.css';

/** Create the TanStack Router instance with the generated route tree */
const router = createRouter({ routeTree });

/**
 * TypeScript module augmentation for TanStack Router.
 * Provides type safety for router hooks and components.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/** Render the application to the DOM */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
