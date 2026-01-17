import { useDashboardStore } from '../stores/dashboard';

interface ServerInfo {
  url: string;
  healthy: boolean;
  weight: number;
  currentConnections: number;
  totalRequests: number;
  failedRequests: number;
  successRate: string;
  lastCheck: string | null;
  lastError: string | null;
  circuitState: string;
}

interface LbStatus {
  totalServers: number;
  healthyServers: number;
  servers: ServerInfo[];
}

export function LoadBalancerCard() {
  const { lbStatus } = useDashboardStore();

  const status = lbStatus as LbStatus | null;

  if (!status) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Load Balancer</h3>
        <p className="text-gray-500 text-sm">
          Load balancer not running or not accessible.
          <br />
          Start it with: <code className="bg-gray-100 px-1 rounded">npm run dev:lb</code>
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Load Balancer</h3>
        <span
          className={`px-2 py-1 rounded-full text-xs font-medium ${
            status.healthyServers === status.totalServers
              ? 'status-healthy'
              : status.healthyServers > 0
              ? 'status-degraded'
              : 'status-unhealthy'
          }`}
        >
          {status.healthyServers}/{status.totalServers} Healthy
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {status.servers.map((server) => (
          <div
            key={server.url}
            className={`border rounded-lg p-4 ${
              server.healthy ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-sm text-gray-700">{server.url}</span>
              <span
                className={`w-3 h-3 rounded-full ${
                  server.healthy ? 'bg-green-500' : 'bg-red-500'
                }`}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
              <div>
                <span className="text-gray-500">Connections:</span> {server.currentConnections}
              </div>
              <div>
                <span className="text-gray-500">Weight:</span> {server.weight}
              </div>
              <div>
                <span className="text-gray-500">Requests:</span> {server.totalRequests}
              </div>
              <div>
                <span className="text-gray-500">Success:</span> {server.successRate}
              </div>
              <div className="col-span-2">
                <span className="text-gray-500">Circuit:</span>{' '}
                <span
                  className={`px-1 rounded ${
                    server.circuitState === 'closed'
                      ? 'bg-green-200 text-green-800'
                      : server.circuitState === 'open'
                      ? 'bg-red-200 text-red-800'
                      : 'bg-yellow-200 text-yellow-800'
                  }`}
                >
                  {server.circuitState}
                </span>
              </div>
            </div>

            {server.lastError && (
              <div className="mt-2 text-xs text-red-600 truncate" title={server.lastError}>
                Error: {server.lastError}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
