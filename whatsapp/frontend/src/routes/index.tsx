/**
 * Index Route Component
 *
 * Main entry point route that handles the root URL (/).
 * Displays the chat interface for authenticated users,
 * or login/registration forms for unauthenticated visitors.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { LoginForm } from '../components/LoginForm';
import { RegisterForm } from '../components/RegisterForm';
import { ChatLayout } from '../components/ChatLayout';

/**
 * Index page component that conditionally renders based on auth state.
 */
function IndexPage() {
  const { user } = useAuthStore();
  const [isRegistering, setIsRegistering] = useState(false);

  // If logged in, show chat
  if (user) {
    return <ChatLayout />;
  }

  // Otherwise show login/register
  return (
    <div className="min-h-screen bg-gradient-to-b from-whatsapp-teal-green to-whatsapp-dark-green flex items-center justify-center p-4">
      {isRegistering ? (
        <RegisterForm onSwitchToLogin={() => setIsRegistering(false)} />
      ) : (
        <LoginForm onSwitchToRegister={() => setIsRegistering(true)} />
      )}
    </div>
  );
}

/**
 * Route configuration for the index/home page.
 * Maps to the root URL path (/).
 */
export const Route = createFileRoute('/')({
  component: IndexPage,
});
