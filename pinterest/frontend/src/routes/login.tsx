import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const { login, error, clearError, isLoading } = useAuthStore();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      clearError();
      try {
        await login(username, password);
        navigate({ to: '/' });
      } catch {
        // Error is handled by the store
      }
    },
    [username, password, login, navigate, clearError],
  );

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-modal p-8">
          {/* Logo */}
          <div className="flex justify-center mb-6">
            <svg className="w-10 h-10" viewBox="0 0 24 24" fill="#E60023">
              <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
            </svg>
          </div>

          <h1 className="text-3xl font-bold text-center mb-2">Welcome to Pinterest</h1>
          <p className="text-text-secondary text-center mb-6">Find ideas you love</p>

          {error && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl mb-4 text-sm text-center">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold mb-1">Username</label>
              <input
                type="text"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                required
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Password</label>
              <input
                type="password"
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="w-full btn-pinterest py-3 text-base"
            >
              {isLoading ? 'Logging in...' : 'Log in'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-text-secondary">
              Not on Pinterest yet?{' '}
              <Link to="/register" className="text-pinterest-red font-semibold hover:underline">
                Sign up
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
