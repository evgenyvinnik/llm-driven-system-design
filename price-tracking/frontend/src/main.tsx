/**
 * Application entry point.
 * Creates TanStack Router instance and mounts React app.
 * @module main
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './index.css';

/** TanStack Router instance configured with generated route tree */
const router = createRouter({ routeTree });

/** Router type registration for type-safe routing */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/** Mount React application to DOM */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
