import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { login, error, clearError } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setIsSubmitting(true);
    clearError();

    try {
      await login(username.trim(), password);
      navigate({ to: '/' });
    } catch {
      // Error is handled by store
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-twitter-background">
      <div className="w-full max-w-md p-8 bg-white rounded-2xl shadow-lg">
        <div className="text-center mb-8">
          <svg viewBox="0 0 24 24" className="w-12 h-12 mx-auto text-twitter-blue fill-current">
            <path d="M23.643 4.937c-.835.37-1.732.62-2.675.733.962-.576 1.7-1.49 2.048-2.578-.9.534-1.897.922-2.958 1.13-.85-.904-2.06-1.47-3.4-1.47-2.572 0-4.658 2.086-4.658 4.66 0 .364.042.718.12 1.06-3.873-.195-7.304-2.05-9.602-4.868-.4.69-.63 1.49-.63 2.342 0 1.616.823 3.043 2.072 3.878-.764-.025-1.482-.234-2.11-.583v.06c0 2.257 1.605 4.14 3.737 4.568-.392.106-.803.162-1.227.162-.3 0-.593-.028-.877-.082.593 1.85 2.313 3.198 4.352 3.234-1.595 1.25-3.604 1.995-5.786 1.995-.376 0-.747-.022-1.112-.065 2.062 1.323 4.51 2.093 7.14 2.093 8.57 0 13.255-7.098 13.255-13.254 0-.2-.005-.402-.014-.602.91-.658 1.7-1.477 2.323-2.41z" />
          </svg>
          <h1 className="text-2xl font-bold mt-4">Log in to Twitter</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {error}
            </div>
          )}

          <div>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              className="w-full px-4 py-3 border border-twitter-extraLightGray rounded-lg focus:outline-none focus:border-twitter-blue focus:ring-1 focus:ring-twitter-blue"
            />
          </div>

          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full px-4 py-3 border border-twitter-extraLightGray rounded-lg focus:outline-none focus:border-twitter-blue focus:ring-1 focus:ring-twitter-blue"
            />
          </div>

          <button
            type="submit"
            disabled={!username.trim() || !password || isSubmitting}
            className="w-full py-3 bg-twitter-dark text-white rounded-full font-bold hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? 'Logging in...' : 'Log in'}
          </button>
        </form>

        <div className="mt-6 text-center text-twitter-gray">
          Don't have an account?{' '}
          <Link to="/register" className="text-twitter-blue hover:underline">
            Sign up
          </Link>
        </div>

        <div className="mt-4 p-4 bg-gray-50 rounded-lg text-sm text-twitter-gray">
          <p className="font-medium text-twitter-dark mb-2">Demo accounts:</p>
          <p>Username: alice, bob, charlie, diana, eve, frank, grace</p>
          <p>Password: password123</p>
        </div>
      </div>
    </div>
  );
}
