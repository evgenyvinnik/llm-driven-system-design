/**
 * Analytics Modal Component
 *
 * Shows total clicks, daily trends, referrers, and device breakdown for one link.
 */
import { useEffect, useState } from 'react';
import { UrlAnalytics } from '../types';
import { api, isAbortError } from '../services/api';
import { formatDate } from '../utils/format';

/**
 * Modal component for displaying URL analytics.
 * Shows total clicks, daily trends, referrers, and device breakdown.
 */
export function AnalyticsModal({ shortCode, onClose }: { shortCode: string; onClose: () => void }) {
  const [analytics, setAnalytics] = useState<UrlAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Abort the request when the modal closes or switches links, so a slow response for
    // the previous link can never be rendered under this one.
    const controller = new AbortController();
    setAnalytics(null);
    setError(null);
    setLoading(true);

    api.analytics
      .get(shortCode, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setAnalytics(data);
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
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
