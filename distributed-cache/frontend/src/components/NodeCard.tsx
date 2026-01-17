import type { NodeStatus } from '../types';

interface NodeCardProps {
  node: NodeStatus;
  stats?: {
    hits: number;
    misses: number;
    size: number;
    memoryMB: string;
    hitRate: string;
  };
}

export function NodeCard({ node, stats }: NodeCardProps) {
  return (
    <div
      className={`card border-l-4 ${
        node.healthy
          ? 'border-green-500 bg-green-50'
          : 'border-red-500 bg-red-50'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-lg">
          {node.nodeId || node.url.split('//')[1]}
        </h3>
        <span
          className={`px-2 py-1 rounded-full text-xs font-medium ${
            node.healthy
              ? 'bg-green-200 text-green-800'
              : 'bg-red-200 text-red-800'
          }`}
        >
          {node.healthy ? 'Healthy' : 'Unhealthy'}
        </span>
      </div>

      <div className="text-sm text-gray-600 mb-2">
        <span className="font-mono">{node.url}</span>
      </div>

      {node.healthy && node.uptime !== undefined && (
        <div className="text-sm text-gray-500 mb-3">
          Uptime: {formatUptime(node.uptime)}
        </div>
      )}

      {!node.healthy && node.error && (
        <div className="text-sm text-red-600 mb-3">
          Error: {node.error}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-gray-200">
          <div>
            <span className="text-xs text-gray-500">Keys</span>
            <p className="font-semibold">{stats.size.toLocaleString()}</p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Memory</span>
            <p className="font-semibold">{stats.memoryMB} MB</p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Hit Rate</span>
            <p className="font-semibold">{stats.hitRate}%</p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Operations</span>
            <p className="font-semibold">
              {(stats.hits + stats.misses).toLocaleString()}
            </p>
          </div>
        </div>
      )}

      <div className="text-xs text-gray-400 mt-3">
        Last check: {new Date(node.lastCheck).toLocaleTimeString()}
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
