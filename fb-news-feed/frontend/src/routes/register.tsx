import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { useAuthStore } from '@/stores/authStore';

export const Route = createFileRoute('/register')({
  component: RegisterPage,
});

function RegisterPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const { register } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setIsLoading(true);

    try {
      await register(username, email, password, displayName);
      navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-facebook-gray py-12 px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <svg className="w-14 h-14 mx-auto text-facebook-blue" viewBox="0 0 36 36" fill="currentColor">
            <path d="M20.181 35.87C29.094 34.791 36 27.202 36 18c0-9.941-8.059-18-18-18S0 8.059 0 18c0 4.991 2.032 9.507 5.313 12.763l.006.006C7.877 33.328 11.67 35.136 15.9 35.809v-9.915h-4.4V21.5h4.4v-3.1c0-4.357 2.588-6.76 6.531-6.76 1.897 0 3.87.34 3.87.34v4.27h-2.18c-2.15 0-2.82 1.335-2.82 2.705V21.5h4.8l-.77 4.394h-4.03v9.976z" />
          </svg>
          <h1 className="mt-4 text-2xl font-bold text-facebook-text">Create a new account</h1>
          <p className="text-facebook-darkGray">It's quick and easy.</p>
        </div>

        {/* Register Form */}
        <div className="bg-white rounded-lg shadow-lg p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-md text-sm">
                {error}
              </div>
            )}

            <div>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Full name"
                required
                className="w-full px-4 py-3 border border-gray-300 rounded-md text-facebook-text placeholder-facebook-darkGray focus:outline-none focus:ring-2 focus:ring-facebook-blue focus:border-transparent"
              />
            </div>

            <div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="Username"
                required
                className="w-full px-4 py-3 border border-gray-300 rounded-md text-facebook-text placeholder-facebook-darkGray focus:outline-none focus:ring-2 focus:ring-facebook-blue focus:border-transparent"
              />
              <p className="mt-1 text-xs text-facebook-darkGray">
                Only lowercase letters, numbers, and underscores
              </p>
            </div>

            <div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                required
                className="w-full px-4 py-3 border border-gray-300 rounded-md text-facebook-text placeholder-facebook-darkGray focus:outline-none focus:ring-2 focus:ring-facebook-blue focus:border-transparent"
              />
            </div>

            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                minLength={6}
                className="w-full px-4 py-3 border border-gray-300 rounded-md text-facebook-text placeholder-facebook-darkGray focus:outline-none focus:ring-2 focus:ring-facebook-blue focus:border-transparent"
              />
              <p className="mt-1 text-xs text-facebook-darkGray">
                At least 6 characters
              </p>
            </div>

            <Button
              type="submit"
              className="w-full py-3 text-lg bg-green-500 hover:bg-green-600"
              isLoading={isLoading}
            >
              Sign Up
            </Button>
          </form>

          <div className="mt-6 text-center">
            <Link to="/login" className="text-facebook-blue hover:underline font-semibold">
              Already have an account?
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
