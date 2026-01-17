import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { login, error, clearError, isLoading } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(username, password);
      navigate({ to: '/' });
    } catch {
      // Error handled by store
    }
  };

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-white text-center mb-8">Sign in to GitHub</h1>

        <form onSubmit={handleSubmit} className="bg-github-surface border border-github-border rounded-md p-6">
          {error && (
            <div className="mb-4 p-3 bg-red-900/20 border border-red-800 rounded-md text-sm text-red-400">
              {error}
              <button onClick={clearError} className="ml-2 text-red-300 hover:text-red-200">
                &times;
              </button>
            </div>
          )}

          <div className="mb-4">
            <label htmlFor="username" className="block text-sm font-medium text-github-text mb-2">
              Username or email address
            </label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 bg-github-bg border border-github-border rounded-md focus:outline-none focus:border-github-accent focus:ring-1 focus:ring-github-accent"
              required
            />
          </div>

          <div className="mb-6">
            <label htmlFor="password" className="block text-sm font-medium text-github-text mb-2">
              Password
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-github-bg border border-github-border rounded-md focus:outline-none focus:border-github-accent focus:ring-1 focus:ring-github-accent"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2 bg-github-success text-white font-semibold rounded-md hover:bg-green-600 disabled:opacity-50"
          >
            {isLoading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="mt-4 p-4 border border-github-border rounded-md text-center text-sm">
          New to GitHub?{' '}
          <a href="/register" className="text-github-accent hover:underline">
            Create an account
          </a>
        </div>
      </div>
    </div>
  );
}
