import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { cacheApi } from '../services/api';
import { KeyListItem } from '../components/KeyListItem';
import type { CacheEntry, KeysResponse } from '../types';

export const Route = createFileRoute('/keys')({
  component: KeysPage,
});

function KeysPage() {
  const [keysData, setKeysData] = useState<KeysResponse | null>(null);
  const [pattern, setPattern] = useState('*');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<CacheEntry | null>(null);
  const [keyLocation, setKeyLocation] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await cacheApi.getKeys(pattern);
      setKeysData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch keys');
    } finally {
      setIsLoading(false);
    }
  }, [pattern]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleView = async (key: string) => {
    try {
      const [entry, location] = await Promise.all([
        cacheApi.get(key),
        cacheApi.locateKey(key),
      ]);
      setSelectedKey(entry);
      setKeyLocation(location.nodeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get key');
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`Are you sure you want to delete "${key}"?`)) return;

    try {
      await cacheApi.delete(key);
      setSelectedKey(null);
      fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete key');
    }
  };

  const handleFlush = async () => {
    if (!confirm('Are you sure you want to flush ALL keys from ALL nodes?')) return;

    try {
      await cacheApi.flush();
      setSelectedKey(null);
      fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to flush cache');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">Cache Keys</h2>
        <button onClick={handleFlush} className="btn btn-danger">
          Flush All
        </button>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
          <button onClick={() => setError(null)} className="ml-4 text-red-500">
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Key List */}
        <div className="card">
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Pattern (e.g., user:*)"
              className="input flex-1"
            />
            <button onClick={fetchKeys} disabled={isLoading} className="btn btn-primary">
              {isLoading ? 'Loading...' : 'Search'}
            </button>
          </div>

          {keysData && (
            <div className="mb-3 text-sm text-gray-600">
              Found {keysData.totalCount.toLocaleString()} keys
              {Object.keys(keysData.perNode).length > 1 && (
                <span className="ml-2">
                  ({Object.entries(keysData.perNode)
                    .map(([node, count]) => `${node.split(':').pop()}: ${count}`)
                    .join(', ')})
                </span>
              )}
            </div>
          )}

          <div className="max-h-96 overflow-y-auto border border-gray-200 rounded">
            {keysData?.keys.length ? (
              keysData.keys.map((key) => (
                <KeyListItem
                  key={key}
                  keyName={key}
                  onView={handleView}
                  onDelete={handleDelete}
                  isSelected={selectedKey?.key === key}
                />
              ))
            ) : (
              <div className="p-4 text-center text-gray-500">
                {isLoading ? 'Loading...' : 'No keys found'}
              </div>
            )}
          </div>
        </div>

        {/* Key Details */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Key Details</h3>
          {selectedKey ? (
            <div className="space-y-4">
              <div>
                <label className="label">Key</label>
                <code className="block bg-gray-100 p-2 rounded font-mono text-sm break-all">
                  {selectedKey.key}
                </code>
              </div>

              <div>
                <label className="label">Value</label>
                <pre className="bg-gray-100 p-3 rounded overflow-auto max-h-64 text-sm">
                  {typeof selectedKey.value === 'object'
                    ? JSON.stringify(selectedKey.value, null, 2)
                    : String(selectedKey.value)}
                </pre>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">TTL</label>
                  <p className="font-mono">
                    {selectedKey.ttl === -1 ? 'No expiration' : `${selectedKey.ttl}s`}
                  </p>
                </div>
                <div>
                  <label className="label">Node</label>
                  <p className="font-mono text-sm">{keyLocation || 'Unknown'}</p>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => handleDelete(selectedKey.key)}
                  className="btn btn-danger"
                >
                  Delete Key
                </button>
                <button
                  onClick={() => setSelectedKey(null)}
                  className="btn btn-secondary"
                >
                  Clear Selection
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center text-gray-500 py-8">
              Select a key to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
