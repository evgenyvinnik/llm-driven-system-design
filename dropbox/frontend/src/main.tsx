/**
 * Application entry point.
 * Sets up TanStack Router and renders the app to the DOM.
 * @module main
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './index.css';

/** TanStack Router instance configured with the generated route tree */
const router = createRouter({ routeTree });

/** Module augmentation for TanStack Router type safety */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
