/**
 * Webhooks Route
 *
 * Webhook management page for configuring endpoints and monitoring event delivery.
 * Allows merchants to set up webhook URLs, view delivery history,
 * and retry failed webhook deliveries.
 *
 * @module routes/webhooks
 */

import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { listWebhookEvents, getWebhookEndpoint, updateWebhookEndpoint, deleteWebhookEndpoint, retryWebhook } from '@/services/api';
import { formatDate } from '@/utils';
import { StatusBadge } from '@/components';
import type { WebhookEvent, WebhookEndpoint } from '@/types';

/**
 * Route definition for the webhooks page (/webhooks).
 */
export const Route = createFileRoute('/webhooks')({
  component: WebhooksPage,
});

/**
 * Webhooks page component.
 * Displays webhook endpoint configuration, event history,
 * and provides ability to configure endpoints and retry deliveries.
 *
 * @returns The webhooks management page
 */
function WebhooksPage() {
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [endpoint, setEndpoint] = useState<WebhookEndpoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<WebhookEvent | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  /**
   * Fetches webhook events and endpoint configuration.
   */
  async function loadData() {
    try {
      setLoading(true);
      const [eventsData, endpointData] = await Promise.all([
        listWebhookEvents({ limit: 50 }),
        getWebhookEndpoint(),
      ]);
      setEvents(eventsData.data);
      setEndpoint(endpointData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Queues a failed webhook event for redelivery.
   * @param eventId - The event ID to retry
   */
  async function handleRetry(eventId: string) {
    try {
      await retryWebhook(eventId);
      alert('Webhook queued for retry');
      loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to retry webhook');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-stripe-gray-900">Webhooks</h1>
          <p className="text-stripe-gray-500 mt-1">Monitor webhook deliveries and configure endpoints</p>
        </div>
        <button onClick={() => setShowConfig(true)} className="btn-primary">
          Configure Endpoint
        </button>
      </div>

      {/* Endpoint Status */}
      <div className="card card-body">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-stripe-gray-500">Webhook Endpoint</div>
            {endpoint?.url ? (
              <div className="font-mono text-sm mt-1">{endpoint.url}</div>
            ) : (
              <div className="text-stripe-gray-400 mt-1">No endpoint configured</div>
            )}
          </div>
          <div>
            {endpoint?.enabled ? (
              <span className="badge-success">Active</span>
            ) : (
              <span className="badge-gray">Inactive</span>
            )}
          </div>
        </div>
        {endpoint?.secret && (
          <div className="mt-4 p-3 bg-stripe-gray-50 rounded-lg">
            <div className="text-xs text-stripe-gray-500 mb-1">Signing Secret</div>
            <code className="text-sm font-mono break-all">{endpoint.secret}</code>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Events List */}
        <div className="lg:col-span-2">
          <div className="card">
            <div className="card-header flex items-center justify-between">
              <h2 className="font-semibold">Recent Events</h2>
              <button onClick={loadData} className="btn-secondary btn-sm">
                Refresh
              </button>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Event Type</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={4} className="text-center py-8">
                      Loading...
                    </td>
                  </tr>
                ) : events.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center py-8 text-stripe-gray-500">
                      No webhook events yet
                    </td>
                  </tr>
                ) : (
                  events.map((event) => (
                    <tr
                      key={event.id}
                      className={`cursor-pointer ${selectedEvent?.id === event.id ? 'bg-stripe-purple/5' : ''}`}
                      onClick={() => setSelectedEvent(event)}
                    >
                      <td className="font-mono text-sm">{event.type}</td>
                      <td>
                        <StatusBadge status={event.status} />
                      </td>
                      <td>{event.attempts}</td>
                      <td className="text-stripe-gray-500">
                        {formatDate(event.created)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Event Detail */}
        <div className="lg:col-span-1">
          {selectedEvent ? (
            <div className="card">
              <div className="card-header">
                <h3 className="font-semibold">Event Details</h3>
              </div>
              <div className="card-body space-y-4">
                <div>
                  <div className="text-sm text-stripe-gray-500">Event Type</div>
                  <div className="font-mono">{selectedEvent.type}</div>
                </div>

                <div>
                  <div className="text-sm text-stripe-gray-500">Status</div>
                  <StatusBadge status={selectedEvent.status} />
                </div>

                <div>
                  <div className="text-sm text-stripe-gray-500">Attempts</div>
                  <div>{selectedEvent.attempts}</div>
                </div>

                {selectedEvent.last_error && (
                  <div>
                    <div className="text-sm text-stripe-gray-500">Last Error</div>
                    <div className="text-sm text-red-600 bg-red-50 p-2 rounded">
                      {selectedEvent.last_error}
                    </div>
                  </div>
                )}

                {selectedEvent.delivered_at && (
                  <div>
                    <div className="text-sm text-stripe-gray-500">Delivered At</div>
                    <div>{formatDate(new Date(selectedEvent.delivered_at).getTime() / 1000)}</div>
                  </div>
                )}

                <div>
                  <div className="text-sm text-stripe-gray-500">Payload</div>
                  <pre className="text-xs bg-stripe-gray-50 p-3 rounded-lg overflow-auto max-h-48">
                    {JSON.stringify(selectedEvent.data, null, 2)}
                  </pre>
                </div>

                {selectedEvent.status === 'failed' && (
                  <button
                    onClick={() => handleRetry(selectedEvent.id)}
                    className="btn-primary w-full"
                  >
                    Retry Delivery
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="card card-body text-center text-stripe-gray-500">
              Select an event to view details
            </div>
          )}
        </div>
      </div>

      {/* Configure Modal */}
      {showConfig && (
        <ConfigureEndpointModal
          currentUrl={endpoint?.url || ''}
          onClose={() => setShowConfig(false)}
          onSave={async (url) => {
            try {
              if (url) {
                await updateWebhookEndpoint(url);
              } else {
                await deleteWebhookEndpoint();
              }
              setShowConfig(false);
              loadData();
            } catch (err) {
              alert(err instanceof Error ? err.message : 'Failed to update endpoint');
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Modal dialog for configuring the webhook endpoint URL.
 * Allows merchants to set or clear their webhook destination.
 *
 * @param props - Modal props
 * @param props.currentUrl - The currently configured URL (if any)
 * @param props.onClose - Callback to close the modal
 * @param props.onSave - Callback with the new URL when saved
 */
function ConfigureEndpointModal({
  currentUrl,
  onClose,
  onSave,
}: {
  currentUrl: string;
  onClose: () => void;
  onSave: (url: string) => void;
}) {
  const [url, setUrl] = useState(currentUrl);
  const [loading, setLoading] = useState(false);

  /**
   * Handles form submission and calls onSave callback.
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    await onSave(url);
    setLoading(false);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-md p-6">
        <h2 className="text-xl font-bold mb-4">Configure Webhook Endpoint</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Endpoint URL</label>
            <input
              type="url"
              className="input font-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-server.com/webhooks"
            />
            <p className="text-xs text-stripe-gray-500 mt-1">
              Leave empty to disable webhooks
            </p>
          </div>
          <div className="flex gap-3 pt-4">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={loading}>
              {loading ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
