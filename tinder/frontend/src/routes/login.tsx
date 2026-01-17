/**
 * Login route - authentication page for existing users.
 * Provides email/password login form with demo credentials display.
 */
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

/**
 * Login page component.
 * Handles user authentication via email and password.
 * Redirects to home on successful login.
 * @returns Login form element with demo credentials
 */
function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading, error, clearError } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      navigate({ to: '/' });
    } catch {
      // Error is handled by store
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-20 h-20 bg-tinder-gradient rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-10 h-10 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12.0001 2C7.95721 5.50456 6.00098 9.00911 6.00098 12.5137C6.00098 17.5 9.00098 21 12.001 21C15.001 21 18.001 17.5 18.001 12.5137C18.001 9.00911 16.043 5.50456 12.0001 2Z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold bg-tinder-gradient bg-clip-text text-transparent">
            tinder
          </h1>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="card p-6 space-y-4">
          <h2 className="text-xl font-semibold text-center mb-4">Welcome back</h2>

          {error && (
            <div className="bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm">
              {error}
              <button onClick={clearError} className="float-right font-bold">
                x
              </button>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
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
            className="btn btn-primary w-full py-3"
          >
            {isLoading ? 'Logging in...' : 'Log in'}
          </button>
        </form>

        {/* Register link */}
        <p className="text-center mt-6 text-gray-600">
          Don't have an account?{' '}
          <Link to="/register" className="text-gradient-start font-medium hover:underline">
            Sign up
          </Link>
        </p>

        {/* Demo credentials */}
        <div className="mt-8 p-4 bg-gray-100 rounded-lg text-sm text-gray-600">
          <p className="font-medium mb-2">Demo accounts:</p>
          <p>Admin: admin@example.com / admin123</p>
          <p>User: alice@example.com / password123</p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
});
