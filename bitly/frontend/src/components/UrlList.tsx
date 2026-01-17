import React, { useEffect, useState } from 'react';
import { Url, UrlAnalytics } from '../types';
import { useUrlStore } from '../stores/urlStore';
import { api } from '../services/api';

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function AnalyticsModal({ shortCode, onClose }: { shortCode: string; onClose: () => void }) {
  const [analytics, setAnalytics] = useState<UrlAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadAnalytics() {
      try {
        const data = await api.analytics.get(shortCode);
        setAnalytics(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        setLoading(false);
      }
    }
    loadAnalytics();
  }, [shortCode]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold">Analytics for /{shortCode}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            X
          </button>
        </div>

        {loading && <p className="text-gray-600">Loading analytics...</p>}
        {error && <p className="text-red-600">{error}</p>}

        {analytics && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="card bg-gray-50">
                <p className="text-3xl font-bold text-primary-600">{analytics.total_clicks}</p>
                <p className="text-sm text-gray-600">Total Clicks</p>
              </div>
            </div>

            {analytics.clicks_by_day.length > 0 && (
              <div>
                <h4 className="font-semibold mb-2">Clicks by Day (Last 30 days)</h4>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="space-y-2">
                    {analytics.clicks_by_day.slice(0, 7).map((day) => (
                      <div key={day.date} className="flex justify-between">
                        <span className="text-gray-600">{formatDate(day.date)}</span>
                        <span className="font-medium">{day.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {analytics.top_referrers.length > 0 && (
              <div>
                <h4 className="font-semibold mb-2">Top Referrers</h4>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="space-y-2">
                    {analytics.top_referrers.map((ref) => (
                      <div key={ref.referrer} className="flex justify-between">
                        <span className="text-gray-600 truncate mr-4">{ref.referrer}</span>
                        <span className="font-medium">{ref.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {analytics.devices.length > 0 && (
              <div>
                <h4 className="font-semibold mb-2">Devices</h4>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="space-y-2">
                    {analytics.devices.map((device) => (
                      <div key={device.device} className="flex justify-between">
                        <span className="text-gray-600 capitalize">{device.device}</span>
                        <span className="font-medium">{device.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function UrlList() {
  const { urls, total, isLoading, error, loadUrls, deleteUrl } = useUrlStore();
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    loadUrls();
  }, [loadUrls]);

  const handleDelete = async (shortCode: string) => {
    await deleteUrl(shortCode);
    setConfirmDelete(null);
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (isLoading && urls.length === 0) {
    return <div className="text-center py-8 text-gray-600">Loading your URLs...</div>;
  }

  if (error) {
    return <div className="text-center py-8 text-red-600">{error}</div>;
  }

  if (urls.length === 0) {
    return (
      <div className="text-center py-8 text-gray-600">
        You haven't created any short URLs yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Your URLs ({total})</h2>

      <div className="space-y-3">
        {urls.map((url) => (
          <div key={url.short_code} className="card">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <a
                    href={url.short_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 font-medium hover:underline"
                  >
                    {url.short_url}
                  </a>
                  <button
                    onClick={() => copyToClipboard(url.short_url)}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    Copy
                  </button>
                  {url.is_custom && (
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                      Custom
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 truncate mt-1">{url.long_url}</p>
                <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                  <span>{url.click_count} clicks</span>
                  <span>Created {formatDate(url.created_at)}</span>
                  {url.expires_at && (
                    <span>Expires {formatDate(url.expires_at)}</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelectedUrl(url.short_code)}
                  className="btn btn-secondary text-sm"
                >
                  Analytics
                </button>
                {confirmDelete === url.short_code ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDelete(url.short_code)}
                      className="btn btn-danger text-sm"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="btn btn-secondary text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(url.short_code)}
                    className="btn btn-secondary text-sm text-red-600"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {selectedUrl && (
        <AnalyticsModal
          shortCode={selectedUrl}
          onClose={() => setSelectedUrl(null)}
        />
      )}
    </div>
  );
}
