import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores';
import { Button } from '../components/Button';
import { Input } from '../components/Input';

function LoginPage() {
  const [username, setUsername] = useState('alice@example.com');
  const [password, setPassword] = useState('password123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuthStore();
  const navigate = useNavigate();

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
    <div className="min-h-screen bg-split-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2.5 mb-2">
            <span className="w-11 h-11 rounded-2xl bg-split-green flex items-center justify-center text-white text-2xl font-black">S</span>
            <span className="text-3xl font-extrabold text-split-ink tracking-tight">Splitwise</span>
          </div>
          <p className="text-split-ink-soft">Share expenses. Settle up. Stay friends.</p>
        </div>

        <div className="card p-7 shadow-sm">
          <h1 className="text-xl font-bold text-split-ink mb-5">Log in</h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email or username"
              name="email"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@example.com"
              required
            />
            <Input
              label="Password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
            {error && <p className="text-split-owe-dark text-sm">{error}</p>}
            <Button type="submit" className="w-full" loading={loading}>Log in</Button>
          </form>
          <p className="text-sm text-split-ink-soft text-center mt-5">
            New here?{' '}
            <Link to="/register" className="text-split-green-dark font-semibold hover:underline">Create an account</Link>
          </p>
        </div>

        <p className="text-center text-xs text-split-ink-soft mt-5">
          Demo login is pre-filled — just click <span className="font-semibold">Log in</span>.
        </p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
});
