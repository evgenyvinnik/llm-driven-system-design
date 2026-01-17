/**
 * @fileoverview Application entry point.
 *
 * Initializes the React application by rendering the router provider
 * into the DOM root element. Uses StrictMode for development warnings.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import './index.css';

/**
 * Mount the React application to the DOM.
 * The router provider handles all navigation and page rendering.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
