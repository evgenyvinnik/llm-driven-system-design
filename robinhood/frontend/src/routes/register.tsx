/**
 * Registration page route (/register).
 * Provides new user account creation form.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

/** Route definition for registration page */
export const Route = createFileRoute('/register')({
  component: RegisterPage,
});

/**
 * Registration page component with account creation form.
 * Redirects to home page on successful registration.
 */
function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const { register, isLoading, error, clearError } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    try {
      await register({ email, password, firstName, lastName });
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
            Create your account
          </h1>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-robinhood-gray-400 mb-2">
                  First Name
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full bg-robinhood-gray-700 text-white rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
                />
              </div>
              <div>
                <label className="block text-sm text-robinhood-gray-400 mb-2">
                  Last Name
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full bg-robinhood-gray-700 text-white rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
                />
              </div>
            </div>

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
                minLength={6}
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
              {isLoading ? 'Creating account...' : 'Sign Up'}
            </button>
          </form>

          <p className="text-center text-robinhood-gray-400 mt-6">
            Already have an account?{' '}
            <a href="/login" className="text-robinhood-green hover:underline">
              Log in
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
