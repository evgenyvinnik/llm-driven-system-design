import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useCacheStore } from '../stores/cache-store';
import { StatsCard } from '../components/StatsCard';
import { NodeCard } from '../components/NodeCard';

export const Route = createFileRoute('/')({
  component: Dashboard,
});

function Dashboard() {
  const {
    clusterInfo,
    clusterStats,
    isLoading,
    error,
    lastUpdated,
    autoRefresh,
    refreshAll,
    setAutoRefresh,
    clearError,
  } = useCacheStore();

  useEffect(() => {
    refreshAll();

    if (autoRefresh) {
      const interval = setInterval(refreshAll, 5000);
      return () => clearInterval(interval);
    }
  }, [refreshAll, autoRefresh]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Dashboard</h2>
          {lastUpdated && (
            <p className="text-sm text-gray-500">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh
          </label>
          <button
            onClick={refreshAll}
            disabled={isLoading}
            className="btn btn-primary"
          >
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded flex items-center justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="text-red-500 hover:text-red-700">
            Dismiss
          </button>
        </div>
      )}

      {/* Stats Cards */}
      {clusterStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatsCard
            title="Total Keys"
            value={clusterStats.totalSize.toLocaleString()}
            color="blue"
          />
          <StatsCard
            title="Hit Rate"
            value={`${clusterStats.overallHitRate}%`}
            subtitle={`${clusterStats.totalHits.toLocaleString()} hits`}
            color={parseFloat(clusterStats.overallHitRate) >= 80 ? 'green' : 'yellow'}
          />
          <StatsCard
            title="Memory Used"
            value={`${clusterStats.totalMemoryMB} MB`}
            color="gray"
          />
          <StatsCard
            title="Active Nodes"
            value={clusterStats.totalNodes}
            subtitle={`of ${clusterInfo?.nodes.length || 0} configured`}
            color={clusterStats.totalNodes > 0 ? 'green' : 'red'}
          />
        </div>
      )}

      {/* Additional Stats */}
      {clusterStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatsCard
            title="Cache Misses"
            value={clusterStats.totalMisses.toLocaleString()}
            color="gray"
          />
          <StatsCard
            title="Sets"
            value={clusterStats.totalSets.toLocaleString()}
            color="gray"
          />
          <StatsCard
            title="Deletes"
            value={clusterStats.totalDeletes.toLocaleString()}
            color="gray"
          />
          <StatsCard
            title="Evictions"
            value={clusterStats.totalEvictions.toLocaleString()}
            color={clusterStats.totalEvictions > 0 ? 'yellow' : 'gray'}
          />
        </div>
      )}

      {/* Node Health */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Node Health</h3>
        {clusterInfo ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {clusterInfo.nodes.map((node) => {
              const nodeStats = clusterStats?.perNode.find(
                (s) => s.nodeUrl === node.url
              );
              return (
                <NodeCard
                  key={node.url}
                  node={node}
                  stats={nodeStats}
                />
              );
            })}
          </div>
        ) : (
          <div className="card text-center py-8 text-gray-500">
            {isLoading ? 'Loading node information...' : 'No node information available'}
          </div>
        )}
      </div>

      {/* Ring Info */}
      {clusterInfo && (
        <div className="card">
          <h3 className="text-lg font-semibold mb-3">Consistent Hash Ring</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Virtual Nodes:</span>
              <span className="ml-2 font-mono">{clusterInfo.ring.virtualNodes}</span>
            </div>
            <div>
              <span className="text-gray-500">Active Nodes:</span>
              <span className="ml-2 font-mono">{clusterInfo.ring.activeNodes.length}</span>
            </div>
          </div>
          <div className="mt-3">
            <span className="text-gray-500 text-sm">Active Node URLs:</span>
            <div className="flex flex-wrap gap-2 mt-2">
              {clusterInfo.ring.activeNodes.map((url) => (
                <span
                  key={url}
                  className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs font-mono"
                >
                  {url}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
