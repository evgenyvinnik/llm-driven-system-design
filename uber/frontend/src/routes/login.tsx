import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, isLoading, error, clearError } = useAuthStore();
  const navigate = useNavigate();

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
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link to="/" className="text-3xl font-bold">Uber</Link>
          <h2 className="text-xl mt-4">Sign in to your account</h2>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {error}
              <button
                type="button"
                onClick={clearError}
                className="ml-2 text-red-800 underline"
              >
                Dismiss
              </button>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="Enter your email"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="Enter your password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full btn btn-primary py-3 disabled:opacity-50"
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>

          <p className="text-center text-sm text-gray-600">
            {"Don't have an account? "}
            <Link to="/register" className="text-black font-medium underline">
              Create one
            </Link>
          </p>
        </form>

        <div className="mt-6 text-center text-sm text-gray-500">
          <p>Quick login:</p>
          <div className="flex justify-center gap-4 mt-2">
            <button
              onClick={() => {
                setEmail('rider1@test.com');
                setPassword('password123');
              }}
              className="text-black underline"
            >
              Rider
            </button>
            <button
              onClick={() => {
                setEmail('driver1@test.com');
                setPassword('password123');
              }}
              className="text-black underline"
            >
              Driver
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
});
