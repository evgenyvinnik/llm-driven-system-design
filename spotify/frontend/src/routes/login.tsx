import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading, error, clearError } = useAuthStore();
  const [email, setEmail] = useState('demo@spotify.local');
  const [password, setPassword] = useState('password123');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      navigate({ to: '/' });
    } catch {
      // Error is handled in store
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center">
      <div className="w-full max-w-md">
        <div className="bg-spotify-dark-gray rounded-lg p-8">
          <h1 className="text-3xl font-bold text-white text-center mb-8">
            Log in to Spotify
          </h1>

          {error && (
            <div className="bg-red-500/20 border border-red-500 text-red-200 px-4 py-3 rounded mb-6">
              {error}
              <button onClick={clearError} className="float-right text-red-200 hover:text-white">
                &times;
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-white mb-2">
                Email address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-spotify-light-gray border border-gray-600 rounded text-white placeholder-spotify-text focus:outline-none focus:border-white"
                placeholder="Email address"
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-white mb-2">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-spotify-light-gray border border-gray-600 rounded text-white placeholder-spotify-text focus:outline-none focus:border-white"
                placeholder="Password"
                required
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 bg-spotify-green text-black font-bold rounded-full hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Logging in...' : 'Log In'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <a href="/register" className="text-spotify-text hover:underline text-sm">
              Don't have an account? <span className="text-white">Sign up for Spotify</span>
            </a>
          </div>

          <div className="mt-4 p-4 bg-spotify-light-gray rounded text-sm text-spotify-text">
            <p className="font-semibold text-white mb-2">Demo credentials:</p>
            <p>Email: demo@spotify.local</p>
            <p>Password: password123</p>
          </div>
        </div>
      </div>
    </div>
  );
}
