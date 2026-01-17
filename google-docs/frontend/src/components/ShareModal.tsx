import { useState } from 'react';
import { documentsApi } from '../services/api';
import type { PermissionLevel } from '../types';

interface Props {
  documentId: string;
  onClose: () => void;
}

export default function ShareModal({ documentId, onClose }: Props) {
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<PermissionLevel>('edit');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleShare = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    setSuccess('');

    try {
      const response = await documentsApi.share(documentId, email, permission);
      if (response.success) {
        setSuccess(`Shared with ${email}`);
        setEmail('');
      } else {
        setError(response.error || 'Failed to share');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b border-docs-border">
          <h2 className="text-lg font-medium">Share document</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-full"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleShare} className="p-4">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm">
              {success}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Add people by email"
              required
              className="flex-1 px-3 py-2 border border-docs-border rounded-lg focus:outline-none focus:border-docs-blue focus:ring-1 focus:ring-docs-blue"
            />

            <select
              value={permission}
              onChange={(e) => setPermission(e.target.value as PermissionLevel)}
              className="px-3 py-2 border border-docs-border rounded-lg focus:outline-none focus:border-docs-blue"
            >
              <option value="view">Viewer</option>
              <option value="comment">Commenter</option>
              <option value="edit">Editor</option>
            </select>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-4 py-2 bg-docs-blue hover:bg-docs-blue-dark text-white rounded-lg disabled:opacity-50"
            >
              {isLoading ? 'Sharing...' : 'Share'}
            </button>
          </div>
        </form>

        <div className="p-4 border-t border-docs-border bg-gray-50 rounded-b-lg">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Get link</h3>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={`${window.location.origin}/document/${documentId}`}
              readOnly
              className="flex-1 px-3 py-2 bg-white border border-docs-border rounded-lg text-sm text-gray-600"
            />
            <button
              onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}/document/${documentId}`);
                setSuccess('Link copied!');
              }}
              className="px-4 py-2 border border-docs-border hover:bg-gray-100 rounded-lg text-sm"
            >
              Copy link
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
