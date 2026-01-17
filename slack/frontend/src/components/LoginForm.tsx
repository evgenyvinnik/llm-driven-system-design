/**
 * @fileoverview Login and registration form component.
 * Handles user authentication with email/password and provides demo credentials.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { authApi, workspaceApi } from '../services/api';
import { useAuthStore, useWorkspaceStore } from '../stores';

/**
 * Login/Registration form component.
 * Allows users to sign in or create a new account.
 * On successful auth, fetches workspaces and navigates appropriately.
 * Shows demo credentials for testing purposes.
 */
export function LoginForm() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const { setUser } = useAuthStore();
  const { setWorkspaces } = useWorkspaceStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      let result;
      if (isLogin) {
        result = await authApi.login(email, password);
      } else {
        result = await authApi.register(email, password, username, displayName);
      }

      setUser(result.user);

      // Fetch workspaces
      const workspaces = await workspaceApi.list();
      setWorkspaces(workspaces);

      if (workspaces.length > 0) {
        // Select first workspace and navigate
        await workspaceApi.select(workspaces[0].id);
        navigate({ to: '/workspace/$workspaceId', params: { workspaceId: workspaces[0].id } });
      } else {
        navigate({ to: '/workspace-select' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slack-purple">
      <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-slack-purple mb-2">slack</h1>
          <p className="text-gray-600">
            {isLogin ? 'Sign in to your workspace' : 'Create your account'}
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slack-blue"
              placeholder="name@work-email.com"
              required
            />
          </div>

          {!isLogin && (
            <>
              <div>
                <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">
                  Username
                </label>
                <input
                  type="text"
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slack-blue"
                  placeholder="username"
                  required={!isLogin}
                />
              </div>

              <div>
                <label htmlFor="displayName" className="block text-sm font-medium text-gray-700 mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slack-blue"
                  placeholder="Your Name"
                />
              </div>
            </>
          )}

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slack-blue"
              placeholder="Enter your password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-slack-purple text-white py-2 px-4 rounded-md hover:bg-slack-purple-light transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Please wait...' : isLogin ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            onClick={() => setIsLogin(!isLogin)}
            className="text-slack-blue hover:underline text-sm"
          >
            {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
          </button>
        </div>

        {isLogin && (
          <div className="mt-4 p-4 bg-gray-50 rounded-md text-sm text-gray-600">
            <p className="font-medium mb-1">Demo credentials:</p>
            <p>Email: alice@example.com</p>
            <p>Password: password123</p>
          </div>
        )}
      </div>
    </div>
  );
}
