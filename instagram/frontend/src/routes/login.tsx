import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { Input } from '../components/Input';
import { Button } from '../components/Button';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { login, isAuthenticated } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (isAuthenticated) {
    navigate({ to: '/' });
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(username, password);
      navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-sm mx-auto pt-8">
      <div className="bg-white border border-border-gray p-10 mb-4">
        <h1 className="text-4xl font-semibold text-center mb-8">Instagram</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="text"
            placeholder="Username or email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="text-red-500 text-sm text-center">{error}</p>}
          <Button
            type="submit"
            loading={loading}
            disabled={!username || !password}
            className="w-full"
          >
            Log In
          </Button>
        </form>

        <div className="flex items-center my-6">
          <div className="flex-1 h-px bg-border-gray" />
          <span className="px-4 text-sm text-text-gray font-semibold">OR</span>
          <div className="flex-1 h-px bg-border-gray" />
        </div>

        <p className="text-center text-sm text-text-gray">
          Forgot password?
        </p>
      </div>

      <div className="bg-white border border-border-gray p-6 text-center">
        <p className="text-sm">
          Don't have an account?{' '}
          <Link to="/register" className="text-primary font-semibold">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
