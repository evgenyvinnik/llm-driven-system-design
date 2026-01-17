import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/register')({
  component: RegisterPage,
});

function RegisterPage() {
  const navigate = useNavigate();
  const { register, error, clearError, isLoading } = useAuthStore();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await register(username, email, password);
      navigate({ to: '/' });
    } catch {
      // Error handled by store
    }
  };

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-white text-center mb-8">Create your account</h1>

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
              Username
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

          <div className="mb-4">
            <label htmlFor="email" className="block text-sm font-medium text-github-text mb-2">
              Email address
            </label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
              minLength={8}
            />
            <p className="mt-1 text-xs text-github-muted">Make sure it's at least 8 characters.</p>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2 bg-github-success text-white font-semibold rounded-md hover:bg-green-600 disabled:opacity-50"
          >
            {isLoading ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        <div className="mt-4 p-4 border border-github-border rounded-md text-center text-sm">
          Already have an account?{' '}
          <a href="/login" className="text-github-accent hover:underline">
            Sign in
          </a>
        </div>
      </div>
    </div>
  );
}
