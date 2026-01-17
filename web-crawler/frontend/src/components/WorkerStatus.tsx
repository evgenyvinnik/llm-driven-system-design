interface WorkerStatusProps {
  workers: string[];
  heartbeats: { workerId: string; lastHeartbeat: number }[];
}

export function WorkerStatus({ workers, heartbeats }: WorkerStatusProps) {
  const now = Date.now();

  const getWorkerStatus = (workerId: string) => {
    const heartbeat = heartbeats.find((h) => h.workerId === workerId);
    if (!heartbeat) return 'unknown';

    const secondsAgo = (now - heartbeat.lastHeartbeat) / 1000;
    if (secondsAgo < 10) return 'active';
    if (secondsAgo < 30) return 'stale';
    return 'dead';
  };

  const statusColors = {
    active: 'bg-green-500',
    stale: 'bg-yellow-500',
    dead: 'bg-red-500',
    unknown: 'bg-gray-400',
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <h3 className="text-sm font-medium text-gray-900 mb-3">Crawler Workers</h3>

      {workers.length === 0 ? (
        <p className="text-sm text-gray-500">No active workers</p>
      ) : (
        <div className="space-y-2">
          {workers.map((workerId) => {
            const status = getWorkerStatus(workerId);
            const heartbeat = heartbeats.find((h) => h.workerId === workerId);
            const lastSeen = heartbeat
              ? `${Math.floor((now - heartbeat.lastHeartbeat) / 1000)}s ago`
              : 'Never';

            return (
              <div
                key={workerId}
                className="flex items-center justify-between p-2 bg-gray-50 rounded"
              >
                <div className="flex items-center space-x-2">
                  <span className={`w-2 h-2 rounded-full ${statusColors[status]}`}></span>
                  <span className="text-sm font-medium text-gray-700">Worker {workerId}</span>
                </div>
                <span className="text-xs text-gray-500">Last seen: {lastSeen}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-gray-200">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">Total Workers</span>
          <span className="font-medium text-gray-900">{workers.length}</span>
        </div>
      </div>
    </div>
  );
}
