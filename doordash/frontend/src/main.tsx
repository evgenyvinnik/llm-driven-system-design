import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './index.css';

/**
 * Application router instance.
 * Created from the auto-generated route tree and provides
 * type-safe navigation throughout the app.
 */
const router = createRouter({ routeTree });

/**
 * TypeScript module augmentation for TanStack Router.
 * Enables type-safe route navigation and link generation.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/**
 * Application entry point.
 * Mounts the React application with StrictMode enabled and
 * the router provider for client-side navigation.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
