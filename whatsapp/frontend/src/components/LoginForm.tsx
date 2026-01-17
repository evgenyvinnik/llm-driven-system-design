/**
 * Login Form Component
 *
 * Provides user authentication interface with username/password fields.
 * Displays error messages and loading states during authentication.
 * Includes demo account hints for development convenience.
 */

import { useState, FormEvent } from 'react';
import { useAuthStore } from '../stores/authStore';

/**
 * Props for the LoginForm component.
 */
interface LoginFormProps {
  /** Callback to switch to the registration form */
  onSwitchToRegister: () => void;
}

/**
 * Login form with username and password authentication.
 * @param props - Component props including form switch callback
 */
export function LoginForm({ onSwitchToRegister }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { login, isLoading, error, clearError } = useAuthStore();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login(username, password);
    } catch {
      // Error is handled in store
    }
  };

  return (
    <div className="w-full max-w-md">
      <div className="bg-white rounded-lg shadow-lg p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-whatsapp-teal-green">WhatsApp</h1>
          <p className="text-gray-600 mt-2">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              {error}
              <button
                type="button"
                onClick={clearError}
                className="float-right font-bold"
              >
                x
              </button>
            </div>
          )}

          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-700">
              Username
            </label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-green focus:border-whatsapp-green"
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-green focus:border-whatsapp-green"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-whatsapp-green hover:bg-whatsapp-dark-green focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-green disabled:opacity-50"
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-sm text-gray-600">
            Don't have an account?{' '}
            <button
              onClick={onSwitchToRegister}
              className="font-medium text-whatsapp-green hover:text-whatsapp-dark-green"
            >
              Sign up
            </button>
          </p>
        </div>

        <div className="mt-4 text-center text-xs text-gray-500">
          <p>Demo accounts: alice / bob / charlie</p>
          <p>Password: password123</p>
        </div>
      </div>
    </div>
  );
}
