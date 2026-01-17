import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useNavigate, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/login')({
  component: Login,
});

function Login() {
  const navigate = useNavigate();
  const { login, error, clearError, isLoading } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    try {
      await login(email, password);
      navigate({ to: '/' });
    } catch {
      // Error is handled by store
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-apple-red to-apple-pink flex items-center justify-center mx-auto mb-4">
            <span className="text-white text-3xl font-bold">M</span>
          </div>
          <h1 className="text-2xl font-bold">Sign in to Music</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-red-500/20 border border-red-500 text-red-200 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-2">
              Email
            </label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 bg-apple-card border border-apple-border rounded-lg focus:outline-none focus:border-apple-red transition"
              placeholder="you@example.com"
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-2">
              Password
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-apple-card border border-apple-border rounded-lg focus:outline-none focus:border-apple-red transition"
              placeholder="Enter your password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3 bg-apple-red hover:bg-apple-red/80 rounded-lg font-medium transition disabled:opacity-50"
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="text-center mt-6 text-apple-text-secondary">
          Don't have an account?{' '}
          <Link to="/register" className="text-apple-red hover:underline">
            Sign up
          </Link>
        </p>

        <div className="mt-8 p-4 bg-apple-card rounded-lg">
          <p className="text-sm text-apple-text-secondary mb-2">Demo accounts:</p>
          <p className="text-sm">Admin: admin@applemusic.local / admin123</p>
          <p className="text-sm">User: demo@applemusic.local / demo123</p>
        </div>
      </div>
    </div>
  );
}
