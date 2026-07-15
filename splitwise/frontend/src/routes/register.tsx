import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores';
import { Button } from '../components/Button';
import { Input } from '../components/Input';

function RegisterPage() {
  const [form, setForm] = useState({ name: '', username: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { register } = useAuthStore();
  const navigate = useNavigate();

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await register(form);
      navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-split-bg flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2.5 mb-2">
            <span className="w-11 h-11 rounded-2xl bg-split-green flex items-center justify-center text-white text-2xl font-black">S</span>
            <span className="text-3xl font-extrabold text-split-ink tracking-tight">Splitwise</span>
          </div>
          <p className="text-split-ink-soft">Create your account</p>
        </div>

        <div className="card p-7 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input label="Full name" name="name" value={form.name} onChange={set('name')} placeholder="Jane Doe" required />
            <Input label="Username" name="username" value={form.username} onChange={set('username')} placeholder="jane" required />
            <Input label="Email" name="email" type="email" value={form.email} onChange={set('email')} placeholder="jane@example.com" required />
            <Input label="Password" name="password" type="password" value={form.password} onChange={set('password')} placeholder="••••••••" required />
            {error && <p className="text-split-owe-dark text-sm">{error}</p>}
            <Button type="submit" className="w-full" loading={loading}>Sign up</Button>
          </form>
          <p className="text-sm text-split-ink-soft text-center mt-5">
            Already have an account?{' '}
            <Link to="/login" className="text-split-green-dark font-semibold hover:underline">Log in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/register')({
  component: RegisterPage,
});
