/**
 * @fileoverview Operator sign-in form.
 *
 * Shown in place of admin controls when no admin session exists. Inputs use
 * name="username" / name="password" so password managers (and the screenshot
 * harness) can find them.
 *
 * @module components/LoginForm
 */

import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../stores/authStore';

export function LoginForm() {
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="max-w-sm bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4"
      aria-labelledby="login-heading"
    >
      <div>
        <h2 id="login-heading" className="text-lg font-medium text-gray-900">
          Operator sign-in
        </h2>
        <p className="text-sm text-gray-600 mt-1">
          The dashboard is read-only without signing in. Seeding, recovery, domain settings
          and clearing the frontier require an admin session.
        </p>
      </div>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Username</span>
        <input
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary-500 focus:border-primary-500"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary-500 focus:border-primary-500"
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full px-4 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
