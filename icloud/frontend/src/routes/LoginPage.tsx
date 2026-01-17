import React, { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { CloudIcon } from '../components/Icons';
import { generateDeviceName } from '../utils/helpers';

/**
 * Login page component for user authentication.
 *
 * Provides a form for users to sign in with email and password.
 * On successful login, connects the WebSocket and redirects to /drive.
 * Displays demo account credentials for testing purposes.
 *
 * @returns Login form page
 */
export const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, isLoading, error, clearError } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password, generateDeviceName());
      navigate({ to: '/drive' });
    } catch {
      // Error is handled by store
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-blue-50 to-white">
      <div className="w-full max-w-md p-8">
        <div className="text-center mb-8">
          <CloudIcon className="w-16 h-16 mx-auto mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900">Sign in to iCloud</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-100 text-red-700 rounded-lg text-sm flex justify-between items-center">
              <span>{error}</span>
              <button type="button" onClick={clearError} className="text-red-500 hover:text-red-700">
                Dismiss
              </button>
            </div>
          )}

          <div>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
              autoFocus
            />
          </div>

          <div>
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-gray-600">
            Don't have an account?{' '}
            <Link to="/register" className="text-blue-500 hover:underline">
              Create one
            </Link>
          </p>
        </div>

        <div className="mt-8 text-center text-sm text-gray-500">
          <p>Demo accounts:</p>
          <p>admin@icloud.local / admin123</p>
          <p>user@icloud.local / user123</p>
        </div>
      </div>
    </div>
  );
};
