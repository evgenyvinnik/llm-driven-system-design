import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

import { routeTree } from './routeTree.gen';
import { useAuthStore } from './stores/authStore';
import { useWebSocketStore } from './stores/websocketStore';

/**
 * TanStack Router instance configured with the generated route tree.
 * This router handles all client-side navigation.
 */
const router = createRouter({ routeTree });

/**
 * Type augmentation for TanStack Router to provide type-safe navigation.
 * Enables autocomplete and type checking for route paths and params.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/**
 * Root application component.
 *
 * Handles application initialization:
 * - Validates authentication session on mount
 * - Establishes WebSocket connection after auth check completes
 * - Provides the router context for navigation
 *
 * The WebSocket connection is established with the auth token
 * to enable authenticated real-time features.
 *
 * @returns JSX element wrapping RouterProvider
 */
function App() {
  const { checkAuth, token, isLoading } = useAuthStore();
  const { connect } = useWebSocketStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!isLoading) {
      connect(token || undefined);
    }
  }, [isLoading, token, connect]);

  return <RouterProvider router={router} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
