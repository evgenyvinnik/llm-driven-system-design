import { api } from '../services/api';
import { useAuthStore } from '../stores/auth';
import { useDashboardStore } from '../stores/dashboard';

interface CircuitBreaker {
  name: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: string | null;
  stats: {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    rejectedCalls: number;
  };
}

interface CircuitBreakersCardProps {
  breakers?: Record<string, CircuitBreaker>;
}

export function CircuitBreakersCard({ breakers }: CircuitBreakersCardProps) {
  const { token } = useAuthStore();
  const { fetchDashboard } = useDashboardStore();

  const handleReset = async (name: string) => {
    if (!token) return;
    try {
      await api.resetCircuitBreaker(token, name);
      await fetchDashboard();
    } catch (error) {
      console.error('Failed to reset circuit breaker:', error);
    }
  };

  const breakerList = breakers ? Object.values(breakers) : [];

  return (
    <div className="card">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Circuit Breakers</h3>

      {breakerList.length === 0 ? (
        <p className="text-gray-500 text-sm">No circuit breakers registered</p>
      ) : (
        <div className="space-y-3">
          {breakerList.map((breaker) => (
            <div
              key={breaker.name}
              className="border border-gray-100 rounded-lg p-3"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-gray-900">{breaker.name}</span>
                <span
                  className={`px-2 py-1 rounded-full text-xs font-medium ${
                    breaker.state === 'closed'
                      ? 'circuit-closed'
                      : breaker.state === 'open'
                      ? 'circuit-open'
                      : 'circuit-half-open'
                  }`}
                >
                  {breaker.state}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 mb-2">
                <div>Total: {breaker.stats.totalCalls}</div>
                <div>Success: {breaker.stats.successfulCalls}</div>
                <div>Failed: {breaker.stats.failedCalls}</div>
                <div>Rejected: {breaker.stats.rejectedCalls}</div>
              </div>

              {breaker.state !== 'closed' && (
                <button
                  onClick={() => handleReset(breaker.name)}
                  className="btn btn-secondary text-xs py-1 px-2 w-full"
                >
                  Reset
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
