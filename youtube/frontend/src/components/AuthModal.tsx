import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

/**
 * Props for the AuthModal component.
 */
interface AuthModalProps {
  /** Callback to close the modal */
  onClose: () => void;
}

/**
 * Authentication modal component for login and registration.
 * Provides a form that toggles between login and registration modes.
 * Handles form submission, displays errors from the auth store,
 * and closes automatically on successful authentication.
 *
 * @param props.onClose - Called when modal should be dismissed
 */
export default function AuthModal({ onClose }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [channelName, setChannelName] = useState('');
  const { login, register, isLoading, error, clearError } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      if (mode === 'login') {
        await login({ username, password });
      } else {
        await register({ username, email, password, channelName: channelName || undefined });
      }
      onClose();
    } catch {
      // Error is handled by the store
    }
  };

  const switchMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    clearError();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="bg-yt-dark-secondary rounded-xl max-w-md w-full mx-4 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            {/* YouTube logo */}
            <svg viewBox="0 0 90 20" className="h-5 w-auto">
              <g fill="none">
                <path
                  d="M27.9727 3.12324C27.6435 1.89323 26.6768 0.926623 25.4468 0.597366C23.2197 2.24288e-07 14.285 0 14.285 0C14.285 0 5.35042 2.24288e-07 3.12323 0.597366C1.89323 0.926623 0.926623 1.89323 0.597366 3.12324C2.24288e-07 5.35042 0 10 0 10C0 10 2.24288e-07 14.6496 0.597366 16.8768C0.926623 18.1068 1.89323 19.0734 3.12323 19.4026C5.35042 20 14.285 20 14.285 20C14.285 20 23.2197 20 25.4468 19.4026C26.6768 19.0734 27.6435 18.1068 27.9727 16.8768C28.5701 14.6496 28.5701 10 28.5701 10C28.5701 10 28.5677 5.35042 27.9727 3.12324Z"
                  fill="#FF0000"
                />
                <path
                  d="M11.4253 14.2854L18.8477 10.0004L11.4253 5.71533V14.2854Z"
                  fill="white"
                />
              </g>
            </svg>
            <span className="text-lg font-medium">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-yt-dark-hover rounded-full transition-colors"
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-yt-text-secondary-dark mb-4">
            {mode === 'login'
              ? 'To continue to YouTube'
              : 'Create your YouTube account'}
          </p>

          <div>
            <label className="block text-sm text-yt-text-secondary-dark mb-2">Username</label>
            <input
              id="auth-username"
              name="username"
              autoComplete="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-transparent border border-gray-600 text-white px-4 py-3 rounded-lg focus:border-yt-blue-light focus:outline-none focus:ring-1 focus:ring-yt-blue-light transition-colors"
              placeholder="Enter your username"
              required
            />
          </div>

          {mode === 'register' && (
            <>
              <div>
                <label className="block text-sm text-yt-text-secondary-dark mb-2">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-transparent border border-gray-600 text-white px-4 py-3 rounded-lg focus:border-yt-blue-light focus:outline-none focus:ring-1 focus:ring-yt-blue-light transition-colors"
                  placeholder="you@example.com"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-yt-text-secondary-dark mb-2">
                  Channel name <span className="text-gray-500">(optional)</span>
                </label>
                <input
                  type="text"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  className="w-full bg-transparent border border-gray-600 text-white px-4 py-3 rounded-lg focus:border-yt-blue-light focus:outline-none focus:ring-1 focus:ring-yt-blue-light transition-colors"
                  placeholder="Defaults to username"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-sm text-yt-text-secondary-dark mb-2">Password</label>
            <input
              id="auth-password"
              name="password"
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-transparent border border-gray-600 text-white px-4 py-3 rounded-lg focus:border-yt-blue-light focus:outline-none focus:ring-1 focus:ring-yt-blue-light transition-colors"
              placeholder="Enter your password"
              required
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-400 text-sm bg-red-400/10 px-3 py-2 rounded-lg">
              <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-yt-blue-light text-black font-medium py-3 rounded-full hover:bg-blue-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-6"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
                Loading...
              </span>
            ) : mode === 'login' ? (
              'Sign in'
            ) : (
              'Create account'
            )}
          </button>
        </form>

        {/* Footer */}
        <div className="px-6 pb-6 pt-2 text-center">
          <p className="text-sm text-yt-text-secondary-dark">
            {mode === 'login' ? (
              <>
                {"Don't have an account? "}
                <button
                  onClick={switchMode}
                  className="text-yt-blue-light hover:underline font-medium"
                >
                  Create one
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  onClick={switchMode}
                  className="text-yt-blue-light hover:underline font-medium"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
