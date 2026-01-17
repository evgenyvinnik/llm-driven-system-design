import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { cacheApi } from '../services/api';
import { NodeCard } from '../components/NodeCard';
import type { ClusterInfo, ClusterStats } from '../types';

export const Route = createFileRoute('/cluster')({
  component: ClusterPage,
});

function ClusterPage() {
  const [clusterInfo, setClusterInfo] = useState<ClusterInfo | null>(null);
  const [clusterStats, setClusterStats] = useState<ClusterStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newNodeUrl, setNewNodeUrl] = useState('');

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [info, stats] = await Promise.all([
        cacheApi.getClusterInfo(),
        cacheApi.getClusterStats(),
      ]);
      setClusterInfo(info);
      setClusterStats(stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch cluster data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAddNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNodeUrl) return;

    try {
      await cacheApi.addNode(newNodeUrl);
      setNewNodeUrl('');
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add node');
    }
  };

  const handleRemoveNode = async (url: string) => {
    if (!confirm(`Remove node ${url} from the cluster?`)) return;

    try {
      await cacheApi.removeNode(url);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove node');
    }
  };

  const handleForceHealthCheck = async () => {
    try {
      await cacheApi.forceHealthCheck();
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run health check');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">Cluster Management</h2>
        <div className="flex gap-2">
          <button onClick={handleForceHealthCheck} className="btn btn-secondary">
            Force Health Check
          </button>
          <button onClick={fetchData} disabled={isLoading} className="btn btn-primary">
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
          <button onClick={() => setError(null)} className="ml-4 text-red-500">
            Dismiss
          </button>
        </div>
      )}

      {/* Coordinator Info */}
      {clusterInfo && (
        <div className="card">
          <h3 className="text-lg font-semibold mb-3">Coordinator</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Port:</span>
              <span className="ml-2 font-mono">{clusterInfo.coordinator.port}</span>
            </div>
            <div>
              <span className="text-gray-500">Uptime:</span>
              <span className="ml-2 font-mono">
                {formatUptime(clusterInfo.coordinator.uptime)}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Virtual Nodes:</span>
              <span className="ml-2 font-mono">{clusterInfo.ring.virtualNodes}</span>
            </div>
            <div>
              <span className="text-gray-500">Active Nodes:</span>
              <span className="ml-2 font-mono">{clusterInfo.ring.activeNodes.length}</span>
            </div>
          </div>
        </div>
      )}

      {/* Add Node Form */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-3">Add Node</h3>
        <form onSubmit={handleAddNode} className="flex gap-2">
          <input
            type="text"
            value={newNodeUrl}
            onChange={(e) => setNewNodeUrl(e.target.value)}
            placeholder="http://localhost:3004"
            className="input flex-1"
          />
          <button type="submit" className="btn btn-primary">
            Add Node
          </button>
        </form>
      </div>

      {/* Node List */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Nodes</h3>
        {clusterInfo ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {clusterInfo.nodes.map((node) => {
              const nodeStats = clusterStats?.perNode.find(
                (s) => s.nodeUrl === node.url
              );
              return (
                <div key={node.url} className="relative">
                  <NodeCard node={node} stats={nodeStats} />
                  <button
                    onClick={() => handleRemoveNode(node.url)}
                    className="absolute top-2 right-2 px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="card text-center py-8 text-gray-500">
            {isLoading ? 'Loading...' : 'No cluster information available'}
          </div>
        )}
      </div>

      {/* Ring Visualization */}
      {clusterInfo && (
        <div className="card">
          <h3 className="text-lg font-semibold mb-3">Hash Ring</h3>
          <p className="text-sm text-gray-600 mb-4">
            The consistent hash ring distributes keys across nodes. Each physical node has{' '}
            {clusterInfo.ring.virtualNodes} virtual nodes for even distribution.
          </p>
          <div className="flex flex-wrap gap-2">
            {clusterInfo.ring.activeNodes.map((url, index) => (
              <div
                key={url}
                className="flex items-center gap-2 px-3 py-2 rounded-full text-sm"
                style={{
                  backgroundColor: getNodeColor(index, 0.2),
                  color: getNodeColor(index, 1),
                }}
              >
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: getNodeColor(index, 1) }}
                />
                {url.split('//')[1]}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function getNodeColor(index: number, alpha: number): string {
  const colors = [
    [59, 130, 246], // blue
    [16, 185, 129], // green
    [245, 158, 11], // amber
    [239, 68, 68], // red
    [139, 92, 246], // purple
    [236, 72, 153], // pink
  ];
  const [r, g, b] = colors[index % colors.length];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
