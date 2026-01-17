import React, { useEffect } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { useAuthStore } from './stores/authStore';

/**
 * Root application component.
 *
 * Initializes authentication state on mount by checking for an existing
 * session cookie. Displays a loading spinner while auth state is being
 * determined, then renders the router once ready.
 *
 * @returns Application with router or loading state
 */
const App: React.FC = () => {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4" />
          <p className="text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  return <RouterProvider router={router} />;
};

export default App;
