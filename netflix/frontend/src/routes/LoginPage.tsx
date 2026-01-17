import React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

export function LoginPage() {
  const navigate = useNavigate();
  const { login, isAuthenticated } = useAuthStore();
  const [email, setEmail] = React.useState('demo@netflix.local');
  const [password, setPassword] = React.useState('demo123');
  const [error, setError] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);

  React.useEffect(() => {
    if (isAuthenticated) {
      navigate({ to: '/profiles' });
    }
  }, [isAuthenticated, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(email, password);
      navigate({ to: '/profiles' });
    } catch (err) {
      setError((err as Error).message || 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{
        backgroundImage: 'linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.6)), url(/login-bg.jpg)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      <div className="w-full max-w-md bg-black/75 p-16 rounded">
        {/* Logo */}
        <h1 className="text-netflix-red text-4xl font-bold mb-8 text-center">NETFLIX</h1>

        <h2 className="text-white text-3xl font-bold mb-8">Sign In</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-orange-500/20 border border-orange-500 text-orange-200 px-4 py-3 rounded">
              {error}
            </div>
          )}

          <div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              className="input-field"
              required
            />
          </div>

          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="input-field"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full btn-primary py-3"
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-8 text-netflix-gray">
          <p className="text-sm">
            Demo credentials:
          </p>
          <p className="text-sm text-netflix-light-gray mt-1">
            Email: demo@netflix.local<br />
            Password: demo123
          </p>
        </div>

        <p className="mt-8 text-netflix-gray text-sm">
          New to Netflix?{' '}
          <button
            onClick={() => navigate({ to: '/register' })}
            className="text-white hover:underline"
          >
            Sign up now
          </button>
        </p>
      </div>
    </div>
  );
}
