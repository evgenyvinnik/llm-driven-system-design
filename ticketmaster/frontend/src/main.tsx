/**
 * Application entry point.
 * Sets up React with StrictMode and TanStack Router for client-side routing.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './index.css';

/**
 * Router instance configured with the generated route tree.
 * TanStack Router provides type-safe routing with automatic code splitting.
 */
const router = createRouter({ routeTree });

/**
 * Module augmentation to register the router type for type-safe navigation.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/**
 * Mount the React application to the DOM.
 * Uses StrictMode for development warnings and checks.
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
