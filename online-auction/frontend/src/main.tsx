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

  // Don't route until the session check has finished.
  //
  // `partialize` persists only the token, so `isAuthenticated` starts false on
  // every page load and `checkAuth` is what flips it — from the effect above,
  // which runs *after* the routed component's own guard effect. Rendering the
  // router immediately therefore sent an authenticated user to /login on every
  // guarded route; /login then saw the restored session and bounced them to /,
  // so "go to /notifications" silently landed on the browse page.
  //
  // Gating here fixes all five guarded routes at once, rather than teaching
  // each one to wait.
  if (isLoading) {
    return null;
  }

  return <RouterProvider router={router} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
