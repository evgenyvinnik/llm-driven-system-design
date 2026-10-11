/**
 * URL List Component
 *
 * Displays the user's shortened URLs with management actions.
 * Includes analytics modal and delete confirmation.
 */
import { useEffect, useState } from 'react';
import { Url } from '../types';
import { useUrlStore } from '../stores/urlStore';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { formatDate } from '../utils/format';
import { AnalyticsModal } from './AnalyticsModal';

/**
 * Lifecycle status shown next to a link. Inactive (deleted or deactivated by an admin)
 * and expired links no longer redirect.
 */
function linkStatus(url: Url): 'active' | 'inactive' | 'expired' {
  if (!url.is_active) return 'inactive';
  if (url.expires_at && new Date(url.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

/**
 * Displays a list of the user's shortened URLs.
 * Provides actions for viewing analytics and deleting URLs.
 */
export function UrlList() {
  const { urls, total, isLoading, error, loadUrls, deleteUrl } = useUrlStore();
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const { copy, status: copyStatus, copiedText } = useCopyToClipboard();

  useEffect(() => {
    loadUrls();
  }, [loadUrls]);

  const handleDelete = async (shortCode: string) => {
    await deleteUrl(shortCode);
    setConfirmDelete(null);
  };

  if (isLoading && urls.length === 0) {
    return <div className="text-center py-8 text-gray-600">Loading your URLs...</div>;
  }

  if (error && urls.length === 0) {
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

      {error && (
        <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm" role="alert">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {urls.map((url) => {
          const status = linkStatus(url);
          const copyFeedback = copiedText === url.short_url ? copyStatus : 'idle';

          return (
            <div key={url.short_code} className={`card ${status === 'active' ? '' : 'opacity-75'}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={url.short_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary-600 font-medium hover:underline"
                    >
                      {url.short_url}
                    </a>
                    <button
                      onClick={() => copy(url.short_url)}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      {copyFeedback === 'copied' ? 'Copied!' : 'Copy'}
                    </button>
                    {copyFeedback === 'failed' && (
                      <span className="text-xs text-red-600" role="alert">
                        Copy failed - select the link to copy it manually
                      </span>
                    )}
                    {url.is_custom && (
                      <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                        Custom
                      </span>
                    )}
                    {status === 'inactive' && (
                      <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">
                        Inactive
                      </span>
                    )}
                    {status === 'expired' && (
                      <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">
                        Expired
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 truncate mt-1">{url.long_url}</p>
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                    <span>{url.click_count} clicks</span>
                    <span>Created {formatDate(url.created_at)}</span>
                    {url.expires_at && (
                      <span>
                        {status === 'expired' ? 'Expired' : 'Expires'} {formatDate(url.expires_at)}
                      </span>
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
                  {status === 'inactive' ? null : confirmDelete === url.short_code ? (
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
          );
        })}
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
