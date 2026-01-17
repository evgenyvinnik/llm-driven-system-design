interface RequestStats {
  total: number;
  byStatus: Record<string, number>;
}

interface DurationStats {
  count: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
}

interface RequestsCardProps {
  requests?: Record<string, RequestStats>;
  durations?: Record<string, DurationStats>;
}

export function RequestsCard({ requests, durations }: RequestsCardProps) {
  if (!requests) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Request Statistics</h3>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  const endpoints = Object.entries(requests);

  return (
    <div className="card">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Request Statistics</h3>

      {endpoints.length === 0 ? (
        <p className="text-gray-500 text-sm">No requests recorded yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Endpoint
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Total
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  2xx
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  4xx
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  5xx
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  P99
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {endpoints.map(([path, stats]) => {
                const duration = durations?.[path];
                const success = Object.entries(stats.byStatus)
                  .filter(([code]) => code.startsWith('2'))
                  .reduce((sum, [, count]) => sum + count, 0);
                const clientErrors = Object.entries(stats.byStatus)
                  .filter(([code]) => code.startsWith('4'))
                  .reduce((sum, [, count]) => sum + count, 0);
                const serverErrors = Object.entries(stats.byStatus)
                  .filter(([code]) => code.startsWith('5'))
                  .reduce((sum, [, count]) => sum + count, 0);

                return (
                  <tr key={path} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-sm font-mono text-gray-900">{path}</td>
                    <td className="px-3 py-2 text-sm text-right text-gray-900">{stats.total}</td>
                    <td className="px-3 py-2 text-sm text-right text-green-600">{success}</td>
                    <td className="px-3 py-2 text-sm text-right text-yellow-600">{clientErrors}</td>
                    <td className="px-3 py-2 text-sm text-right text-red-600">{serverErrors}</td>
                    <td className="px-3 py-2 text-sm text-right text-gray-600">
                      {duration ? `${duration.p99.toFixed(0)}ms` : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
