import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/register')({
  component: RegisterPage,
});

function RegisterPage() {
  const navigate = useNavigate();
  const { register, isLoading, error, clearError } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await register(email, password, username, displayName || undefined);
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
            Sign up for Spotify
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
              <label htmlFor="username" className="block text-sm font-semibold text-white mb-2">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3 bg-spotify-light-gray border border-gray-600 rounded text-white placeholder-spotify-text focus:outline-none focus:border-white"
                placeholder="Username"
                required
              />
            </div>

            <div>
              <label htmlFor="displayName" className="block text-sm font-semibold text-white mb-2">
                Display name (optional)
              </label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-4 py-3 bg-spotify-light-gray border border-gray-600 rounded text-white placeholder-spotify-text focus:outline-none focus:border-white"
                placeholder="Display name"
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
                minLength={6}
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 bg-spotify-green text-black font-bold rounded-full hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Signing up...' : 'Sign Up'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <a href="/login" className="text-spotify-text hover:underline text-sm">
              Already have an account? <span className="text-white">Log in</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
