/**
 * Authentication panel component for user login, registration, and session management.
 *
 * Features:
 * - Login/register form with validation
 * - Anonymous guest access option
 * - User info display when authenticated
 * - Logout functionality
 */
import { useState } from 'react';
import { useAppStore } from '../stores/appStore';

/**
 * Authentication panel that adapts its UI based on authentication state.
 * Shows login/register form when not authenticated, user info when authenticated.
 */
export function AuthPanel() {
  const { user, isAuthenticated, login, register, logout, loginAnonymous } = useAppStore();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  /**
   * Handles form submission for login or registration.
   * Clears form on success, shows error on failure.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        await register(username, password);
      }
      setUsername('');
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Creates an anonymous guest session for quick access.
   */
  const handleAnonymous = async () => {
    setError(null);
    setIsLoading(true);
    try {
      await loginAnonymous();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create anonymous session');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Logs out the current user.
   */
  const handleLogout = async () => {
    try {
      await logout();
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  if (isAuthenticated && user) {
    return (
      <div className="bg-gray-800 p-4 rounded-lg">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm text-gray-400">Signed in as</div>
            <div className="text-white font-medium">{user.username}</div>
          </div>
          <button
            onClick={handleLogout}
            className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 p-4 rounded-lg w-64">
      <div className="flex mb-4">
        <button
          className={`flex-1 py-2 text-sm font-medium rounded-l transition-colors ${
            mode === 'login'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-400 hover:text-white'
          }`}
          onClick={() => setMode('login')}
        >
          Sign In
        </button>
        <button
          className={`flex-1 py-2 text-sm font-medium rounded-r transition-colors ${
            mode === 'register'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-400 hover:text-white'
          }`}
          onClick={() => setMode('register')}
        >
          Register
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full px-3 py-2 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
          minLength={3}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 bg-gray-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
          minLength={6}
        />
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <button
          type="submit"
          disabled={isLoading}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
        >
          {isLoading ? 'Loading...' : mode === 'login' ? 'Sign In' : 'Register'}
        </button>
      </form>

      <div className="mt-4 pt-4 border-t border-gray-700">
        <button
          onClick={handleAnonymous}
          disabled={isLoading}
          className="w-full py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
        >
          Continue as Guest
        </button>
      </div>
    </div>
  );
}
