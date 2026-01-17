interface MetricsCardProps {
  data?: {
    uptime?: { seconds: number; human: string };
    memory?: { heapUsed: number; heapTotal: number; rss: number };
    gauges?: Record<string, number>;
  };
}

export function MetricsCard({ data }: MetricsCardProps) {
  if (!data) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">System Metrics</h3>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  const memoryUsage = data.memory
    ? ((data.memory.heapUsed / data.memory.heapTotal) * 100).toFixed(1)
    : 0;

  return (
    <div className="card">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">System Metrics</h3>

      <div className="space-y-4">
        {/* Memory Usage */}
        <div>
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="text-gray-600">Memory Usage</span>
            <span className="font-medium">{memoryUsage}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-primary-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${memoryUsage}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>{formatBytes(data.memory?.heapUsed || 0)}</span>
            <span>{formatBytes(data.memory?.heapTotal || 0)}</span>
          </div>
        </div>

        {/* RSS Memory */}
        <div className="flex items-center justify-between py-2 border-b border-gray-100">
          <span className="text-sm text-gray-600">RSS Memory</span>
          <span className="text-sm font-medium">{formatBytes(data.memory?.rss || 0)}</span>
        </div>

        {/* Uptime */}
        <div className="flex items-center justify-between py-2 border-b border-gray-100">
          <span className="text-sm text-gray-600">Uptime</span>
          <span className="text-sm font-medium">{data.uptime?.human || 'N/A'}</span>
        </div>

        {/* CPU Metrics */}
        {data.gauges && (
          <>
            <div className="flex items-center justify-between py-2 border-b border-gray-100">
              <span className="text-sm text-gray-600">CPU User Time</span>
              <span className="text-sm font-medium">
                {(data.gauges['nodejs_cpu_user_seconds'] || 0).toFixed(2)}s
              </span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-gray-600">CPU System Time</span>
              <span className="text-sm font-medium">
                {(data.gauges['nodejs_cpu_system_seconds'] || 0).toFixed(2)}s
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
