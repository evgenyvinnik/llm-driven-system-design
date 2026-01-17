// Test Results Component

import { useRateLimiterStore } from '../stores/rateLimiterStore';

export function TestResults() {
  const { testResults } = useRateLimiterStore();

  const allowedCount = testResults.filter((r) => r.allowed).length;
  const deniedCount = testResults.filter((r) => !r.allowed).length;
  const avgLatency =
    testResults.length > 0
      ? testResults.reduce((sum, r) => sum + r.latencyMs, 0) / testResults.length
      : 0;

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Test Results</h2>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <div className="bg-gray-50 rounded p-2 text-center">
          <p className="text-xs text-gray-500">Total</p>
          <p className="text-lg font-bold">{testResults.length}</p>
        </div>
        <div className="bg-green-50 rounded p-2 text-center">
          <p className="text-xs text-green-600">Allowed</p>
          <p className="text-lg font-bold text-green-600">{allowedCount}</p>
        </div>
        <div className="bg-red-50 rounded p-2 text-center">
          <p className="text-xs text-red-600">Denied</p>
          <p className="text-lg font-bold text-red-600">{deniedCount}</p>
        </div>
        <div className="bg-blue-50 rounded p-2 text-center">
          <p className="text-xs text-blue-600">Avg Latency</p>
          <p className="text-lg font-bold text-blue-600">{avgLatency.toFixed(1)}ms</p>
        </div>
      </div>

      {/* Results list */}
      <div className="max-h-64 overflow-y-auto border rounded">
        {testResults.length === 0 ? (
          <p className="text-gray-500 text-center py-8">
            No test results yet. Click "Send Request" to start testing.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="text-left px-3 py-2">Time</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Remaining</th>
                <th className="text-right px-3 py-2">Latency</th>
              </tr>
            </thead>
            <tbody>
              {testResults.map((result, i) => (
                <tr
                  key={result.timestamp + '-' + i}
                  className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                >
                  <td className="px-3 py-2 text-gray-600">
                    {new Date(result.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex px-2 py-1 rounded text-xs font-medium ${
                        result.allowed
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {result.allowed ? 'ALLOWED' : 'DENIED'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {result.remaining}/{result.limit}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-600">
                    {result.latencyMs}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
