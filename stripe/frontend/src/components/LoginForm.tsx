import { useState } from 'react';
import { useMerchantStore } from '@/stores';
import { createMerchant, getMerchant } from '@/services/api';

interface LoginFormProps {
  onSuccess?: () => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const { setCredentials } = useMerchantStore();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [apiKey, setApiKey] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Temporarily set the API key to fetch merchant info
      useMerchantStore.getState().setCredentials(apiKey, '', '');

      const merchant = await getMerchant();
      setCredentials(apiKey, merchant.id, merchant.name);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid API key');
      useMerchantStore.getState().clearCredentials();
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const merchant = await createMerchant({ name, email });
      if (merchant.api_key) {
        setCredentials(merchant.api_key, merchant.id, merchant.name);
        onSuccess?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create merchant');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-stripe-gray-50">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-stripe-purple rounded-xl flex items-center justify-center mx-auto mb-4">
            <span className="font-bold text-3xl text-white">S</span>
          </div>
          <h1 className="text-2xl font-bold text-stripe-gray-900">Stripe Clone</h1>
          <p className="text-stripe-gray-500 mt-2">Payment processing dashboard</p>
        </div>

        <div className="card">
          <div className="flex border-b border-stripe-gray-100">
            <button
              className={`flex-1 py-3 text-center font-medium transition-colors ${
                mode === 'login'
                  ? 'text-stripe-purple border-b-2 border-stripe-purple'
                  : 'text-stripe-gray-500 hover:text-stripe-gray-700'
              }`}
              onClick={() => setMode('login')}
            >
              Sign In
            </button>
            <button
              className={`flex-1 py-3 text-center font-medium transition-colors ${
                mode === 'register'
                  ? 'text-stripe-purple border-b-2 border-stripe-purple'
                  : 'text-stripe-gray-500 hover:text-stripe-gray-700'
              }`}
              onClick={() => setMode('register')}
            >
              Create Account
            </button>
          </div>

          <div className="card-body">
            {mode === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="label">API Key</label>
                  <input
                    type="text"
                    className="input font-mono"
                    placeholder="sk_test_..."
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    required
                  />
                  <p className="text-xs text-stripe-gray-500 mt-1">
                    Enter your merchant API key
                  </p>
                </div>

                {error && (
                  <p className="text-sm text-stripe-red">{error}</p>
                )}

                <button
                  type="submit"
                  className="btn-primary w-full"
                  disabled={loading}
                >
                  {loading ? 'Signing in...' : 'Sign In'}
                </button>

                <div className="text-center text-sm text-stripe-gray-500">
                  <p>Demo API Key:</p>
                  <code className="text-xs bg-stripe-gray-100 px-2 py-1 rounded">
                    sk_test_demo_merchant_key_12345
                  </code>
                </div>
              </form>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label className="label">Business Name</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Acme Inc."
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>

                <div>
                  <label className="label">Email</label>
                  <input
                    type="email"
                    className="input"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>

                {error && (
                  <p className="text-sm text-stripe-red">{error}</p>
                )}

                <button
                  type="submit"
                  className="btn-primary w-full"
                  disabled={loading}
                >
                  {loading ? 'Creating...' : 'Create Account'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
