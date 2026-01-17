import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading, error, clearError } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(username, password);
      navigate({ to: '/' });
    } catch {
      // Error is handled by the store
    }
  };

  return (
    <div className="max-w-md mx-auto mt-8">
      <div className="bg-white rounded border border-gray-200 p-6">
        <h1 className="text-xl font-bold mb-6">Log In</h1>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-2 rounded mb-4">
            {error}
            <button onClick={clearError} className="ml-2 text-red-800 font-bold">
              x
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-reddit-blue"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-reddit-blue"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2 bg-reddit-orange text-white font-medium rounded hover:bg-reddit-orangeDark disabled:opacity-50"
          >
            {isLoading ? 'Logging in...' : 'Log In'}
          </button>
        </form>

        <p className="text-sm text-gray-500 mt-4 text-center">
          New to Reddit?{' '}
          <a href="/register" className="text-reddit-blue hover:underline">
            Sign Up
          </a>
        </p>

        <div className="mt-6 pt-4 border-t border-gray-200">
          <p className="text-sm text-gray-500 text-center mb-2">Demo accounts:</p>
          <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
            <div>admin / password123</div>
            <div>alice / password123</div>
            <div>bob / password123</div>
            <div>charlie / password123</div>
          </div>
        </div>
      </div>
    </div>
  );
}
