/**
 * Login page route (/login).
 * Provides email/password authentication form.
 * Pre-filled with demo credentials for easy testing.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

/** Route definition for login page */
export const Route = createFileRoute('/login')({
  component: LoginPage,
});

/**
 * Login page component with authentication form.
 * Redirects to home page on successful login.
 */
function LoginPage() {
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('password');
  const { login, isLoading, error, clearError } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    try {
      await login(email, password);
      navigate({ to: '/' });
    } catch {
      // Error is handled by the store
    }
  };

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-robinhood-gray-800 rounded-lg p-8">
          <h1 className="text-2xl font-bold text-white text-center mb-8">
            Log in to Robinhood
          </h1>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm text-robinhood-gray-400 mb-2">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-robinhood-gray-700 text-white rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
                required
              />
            </div>

            <div>
              <label className="block text-sm text-robinhood-gray-400 mb-2">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-robinhood-gray-700 text-white rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
                required
              />
            </div>

            {error && (
              <div className="bg-robinhood-red bg-opacity-20 text-robinhood-red rounded-lg p-3 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-robinhood-green text-black py-3 rounded-full font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Logging in...' : 'Log In'}
            </button>
          </form>

          <p className="text-center text-robinhood-gray-400 mt-6">
            Don't have an account?{' '}
            <a href="/register" className="text-robinhood-green hover:underline">
              Sign up
            </a>
          </p>

          <div className="mt-6 p-4 bg-robinhood-gray-700 rounded-lg">
            <p className="text-sm text-robinhood-gray-400 text-center">
              Demo credentials: <br />
              <span className="text-white">demo@example.com / password</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
