/**
 * Login screen for the scheduler dashboard.
 * Establishes the session cookie that every /api/v1 call depends on.
 * @module routes/Login
 */

import { useState, FormEvent } from 'react';
import { useAuthStore } from '../stores';
import { Button } from '../components/UI';

/**
 * Username/password form backed by the session auth API.
 * Rendered by the guard in Layout whenever there is no active session.
 */
export function LoginPage() {
  const { login, loggingIn, error } = useAuthStore();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await login(username, password);
    } catch {
      // Error text is surfaced from the store below.
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-lg bg-blue-600 text-white text-xl font-bold mb-3">
            JS
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Job Scheduler</h1>
          <p className="text-sm text-gray-500 mt-1">
            Distributed scheduling control plane
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white shadow rounded-lg p-6 space-y-4"
        >
          <div>
            <label
              htmlFor="username"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Username
            </label>
            <input
              id="username"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          <Button
            type="submit"
            data-testid="login-submit"
            className="w-full justify-center"
            disabled={loggingIn}
          >
            {loggingIn ? 'Signing in…' : 'Sign in'}
          </Button>

          <p className="text-xs text-gray-500 text-center pt-1">
            Demo credentials: <span className="font-mono">admin</span> /{' '}
            <span className="font-mono">admin123</span>
          </p>
        </form>
      </div>
    </div>
  );
}
