import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { createMerchant, getMerchantProfile } from '../services/api';

function Login() {
  const navigate = useNavigate();
  const { setApiKey, setMerchant, isAuthenticated } = useAuthStore();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [apiKey, setApiKeyInput] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);

  if (isAuthenticated) {
    navigate({ to: '/' });
    return null;
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Set API key and try to fetch profile
      setApiKey(apiKey);

      const merchant = await getMerchantProfile();
      setMerchant(merchant.id, merchant.name);

      navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid API key');
      // Clear the invalid key
      useAuthStore.getState().logout();
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const result = await createMerchant(name, email);
      setNewApiKey(result.api_key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setLoading(false);
    }
  }

  function handleCopyAndLogin() {
    if (newApiKey) {
      navigator.clipboard.writeText(newApiKey);
      setApiKeyInput(newApiKey);
      setNewApiKey(null);
      setMode('login');
    }
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Payment System
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            {mode === 'login'
              ? 'Enter your API key to access your dashboard'
              : 'Create a new merchant account'}
          </p>
        </div>

        {newApiKey && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <h3 className="text-green-800 font-semibold mb-2">
              Account Created Successfully!
            </h3>
            <p className="text-sm text-green-700 mb-2">
              Save your API key securely. You will not see it again:
            </p>
            <div className="bg-white border border-green-300 rounded p-2 font-mono text-sm break-all">
              {newApiKey}
            </div>
            <button
              onClick={handleCopyAndLogin}
              className="mt-4 w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700"
            >
              Copy & Continue to Login
            </button>
          </div>
        )}

        {!newApiKey && (
          <form
            className="mt-8 space-y-6"
            onSubmit={mode === 'login' ? handleLogin : handleRegister}
          >
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
                {error}
              </div>
            )}

            {mode === 'login' ? (
              <div>
                <label
                  htmlFor="apiKey"
                  className="block text-sm font-medium text-gray-700"
                >
                  API Key
                </label>
                <input
                  id="apiKey"
                  type="text"
                  required
                  value={apiKey}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 rounded-md placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  placeholder="pk_..."
                />
              </div>
            ) : (
              <>
                <div>
                  <label
                    htmlFor="name"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Business Name
                  </label>
                  <input
                    id="name"
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 rounded-md placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    placeholder="Acme Inc"
                  />
                </div>
                <div>
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 rounded-md placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    placeholder="merchant@example.com"
                  />
                </div>
              </>
            )}

            <div>
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
              >
                {loading
                  ? 'Loading...'
                  : mode === 'login'
                    ? 'Login'
                    : 'Create Account'}
              </button>
            </div>

            <div className="text-center">
              <button
                type="button"
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  setError(null);
                }}
                className="text-sm text-primary-600 hover:text-primary-700"
              >
                {mode === 'login'
                  ? "Don't have an account? Create one"
                  : 'Already have an API key? Login'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/login')({
  component: Login,
});
