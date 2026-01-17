import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const { register, isLoading, error, clearError } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      return;
    }

    await register(email, name, password);
  };

  return (
    <div className="min-h-screen bg-docs-bg flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-4">
            <svg className="w-10 h-10" viewBox="0 0 48 48" fill="none">
              <path d="M7 6C7 4.89543 7.89543 4 9 4H29L41 16V42C41 43.1046 40.1046 44 39 44H9C7.89543 44 7 43.1046 7 42V6Z" fill="#4285F4"/>
              <path d="M29 4L41 16H31C29.8954 16 29 15.1046 29 14V4Z" fill="#A1C2FA"/>
              <path d="M14 24H34M14 30H34M14 36H26" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <h1 className="text-2xl font-normal text-gray-800">Docs</h1>
          </div>
          <h2 className="text-xl text-gray-600">Create your account</h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
              <button
                type="button"
                onClick={clearError}
                className="float-right text-red-500 hover:text-red-700"
              >
                x
              </button>
            </div>
          )}

          <div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              required
              className="w-full px-4 py-3 border border-docs-border rounded-lg focus:outline-none focus:border-docs-blue focus:ring-1 focus:ring-docs-blue"
            />
          </div>

          <div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              className="w-full px-4 py-3 border border-docs-border rounded-lg focus:outline-none focus:border-docs-blue focus:ring-1 focus:ring-docs-blue"
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
              className="w-full px-4 py-3 border border-docs-border rounded-lg focus:outline-none focus:border-docs-blue focus:ring-1 focus:ring-docs-blue"
            />
          </div>

          <div>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm password"
              required
              className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-1 ${
                confirmPassword && password !== confirmPassword
                  ? 'border-red-400 focus:border-red-500 focus:ring-red-500'
                  : 'border-docs-border focus:border-docs-blue focus:ring-docs-blue'
              }`}
            />
            {confirmPassword && password !== confirmPassword && (
              <p className="text-red-500 text-sm mt-1">Passwords do not match</p>
            )}
          </div>

          <div className="pt-4 flex items-center justify-between">
            <Link
              to="/login"
              className="text-docs-blue hover:text-docs-blue-dark text-sm font-medium"
            >
              Sign in instead
            </Link>
            <button
              type="submit"
              disabled={isLoading || password !== confirmPassword}
              className="bg-docs-blue hover:bg-docs-blue-dark text-white px-6 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Creating...' : 'Create account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
