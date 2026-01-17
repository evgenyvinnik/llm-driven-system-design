import { useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/auth';
import { useDashboardStore } from '../stores/dashboard';

export function ActionsCard() {
  const { token } = useAuthStore();
  const { fetchDashboard } = useDashboardStore();
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleAction = async (action: string, fn: () => Promise<unknown>) => {
    if (!token) return;
    setLoading(action);
    setResult(null);

    try {
      await fn();
      setResult({ type: 'success', message: `${action} completed successfully` });
      await fetchDashboard();
    } catch (error) {
      setResult({
        type: 'error',
        message: error instanceof Error ? error.message : 'Action failed',
      });
    } finally {
      setLoading(null);
    }
  };

  const actions = [
    {
      id: 'clearCache',
      label: 'Clear Cache',
      description: 'Clear all cached data',
      action: () => api.clearCache(token!),
      variant: 'danger',
    },
    {
      id: 'resetMetrics',
      label: 'Reset Metrics',
      description: 'Reset all collected metrics',
      action: () => api.resetMetrics(token!),
      variant: 'secondary',
    },
    {
      id: 'testExternal',
      label: 'Test External Service',
      description: 'Call external service (may fail randomly)',
      action: () => api.callExternalService(token!),
      variant: 'primary',
    },
    {
      id: 'fetchResources',
      label: 'Fetch Resources',
      description: 'Fetch resources to populate cache',
      action: () => api.getResources(token!),
      variant: 'primary',
    },
  ];

  return (
    <div className="card">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Actions</h3>

      {result && (
        <div
          className={`mb-4 px-3 py-2 rounded-md text-sm ${
            result.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          {result.message}
        </div>
      )}

      <div className="space-y-3">
        {actions.map((action) => (
          <div key={action.id} className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">{action.label}</p>
              <p className="text-xs text-gray-500">{action.description}</p>
            </div>
            <button
              onClick={() => handleAction(action.label, action.action)}
              disabled={loading !== null}
              className={`btn text-xs py-1 px-3 ${
                action.variant === 'danger'
                  ? 'btn-danger'
                  : action.variant === 'primary'
                  ? 'btn-primary'
                  : 'btn-secondary'
              }`}
            >
              {loading === action.label ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></div>
              ) : (
                'Run'
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
