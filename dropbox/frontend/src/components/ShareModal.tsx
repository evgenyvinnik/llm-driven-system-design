/**
 * Modal dialog for sharing files and folders.
 * Supports creating shareable links with password, expiration, and download limits.
 * For folders, also allows sharing with specific users via email.
 * @module components/ShareModal
 */

import { useState } from 'react';
import { X, Copy, Check, Lock } from 'lucide-react';
import { FileItem, SharedLink } from '../types';
import { sharingApi } from '../services/api';

/** Props for the ShareModal component */
interface ShareModalProps {
  /** Whether the modal is currently visible */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** The file or folder to share (null if none selected) */
  item: FileItem | null;
}

/**
 * Renders a modal dialog for sharing files and folders.
 * Creates shareable links and manages folder access for specific users.
 */
export function ShareModal({ isOpen, onClose, item }: ShareModalProps) {
  const [link, setLink] = useState<SharedLink | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState('');
  const [expiresInHours, setExpiresInHours] = useState<number | ''>('');
  const [maxDownloads, setMaxDownloads] = useState<number | ''>('');

  // For folder sharing
  const [shareEmail, setShareEmail] = useState('');
  const [shareAccessLevel, setShareAccessLevel] = useState<'view' | 'edit'>('view');

  const handleCreateLink = async () => {
    if (!item) return;

    setIsLoading(true);
    setError('');

    try {
      const newLink = await sharingApi.createLink(item.id, {
        password: password || undefined,
        expiresInHours: expiresInHours || undefined,
        maxDownloads: maxDownloads || undefined,
      });
      setLink(newLink);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleShareFolder = async () => {
    if (!item || !item.isFolder || !shareEmail) return;

    setIsLoading(true);
    setError('');

    try {
      await sharingApi.shareFolder(item.id, shareEmail, shareAccessLevel);
      setShareEmail('');
      alert('Folder shared successfully!');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = () => {
    if (link?.url) {
      navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setLink(null);
    setError('');
    setPassword('');
    setExpiresInHours('');
    setMaxDownloads('');
    setShareEmail('');
    onClose();
  };

  if (!isOpen || !item) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Share "{item.name}"</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-full hover:bg-gray-100 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6">
          {/* Share link section */}
          <div className="mb-6">
            <h3 className="font-medium mb-3">Create shareable link</h3>

            {!link ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Password protection (optional)
                  </label>
                  <div className="relative">
                    <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter password"
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-dropbox-blue"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Expires in (hours)
                    </label>
                    <input
                      type="number"
                      value={expiresInHours}
                      onChange={(e) => setExpiresInHours(e.target.value ? parseInt(e.target.value) : '')}
                      placeholder="Never"
                      min="1"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-dropbox-blue"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Max downloads
                    </label>
                    <input
                      type="number"
                      value={maxDownloads}
                      onChange={(e) => setMaxDownloads(e.target.value ? parseInt(e.target.value) : '')}
                      placeholder="Unlimited"
                      min="1"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-dropbox-blue"
                    />
                  </div>
                </div>

                <button
                  onClick={handleCreateLink}
                  disabled={isLoading}
                  className="w-full py-2 bg-dropbox-blue text-white rounded-lg hover:bg-dropbox-blue-dark transition-colors disabled:opacity-50"
                >
                  {isLoading ? 'Creating...' : 'Create link'}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={link.url}
                    readOnly
                    className="flex-1 px-4 py-2 bg-gray-50 border border-gray-300 rounded-lg text-sm"
                  />
                  <button
                    onClick={copyToClipboard}
                    className="px-4 py-2 bg-dropbox-blue text-white rounded-lg hover:bg-dropbox-blue-dark transition-colors"
                  >
                    {copied ? <Check size={20} /> : <Copy size={20} />}
                  </button>
                </div>
                <p className="text-sm text-gray-500">
                  {password && 'Password protected. '}
                  {link.expiresAt && `Expires ${new Date(link.expiresAt).toLocaleString()}. `}
                  {link.maxDownloads && `Max ${link.maxDownloads} downloads.`}
                </p>
              </div>
            )}
          </div>

          {/* Share with specific users (folders only) */}
          {item.isFolder && (
            <div className="border-t border-gray-200 pt-6">
              <h3 className="font-medium mb-3">Share with people</h3>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={shareEmail}
                  onChange={(e) => setShareEmail(e.target.value)}
                  placeholder="Email address"
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-dropbox-blue"
                />
                <select
                  value={shareAccessLevel}
                  onChange={(e) => setShareAccessLevel(e.target.value as 'view' | 'edit')}
                  className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-dropbox-blue"
                >
                  <option value="view">Can view</option>
                  <option value="edit">Can edit</option>
                </select>
                <button
                  onClick={handleShareFolder}
                  disabled={isLoading || !shareEmail}
                  className="px-4 py-2 bg-dropbox-blue text-white rounded-lg hover:bg-dropbox-blue-dark transition-colors disabled:opacity-50"
                >
                  Share
                </button>
              </div>
            </div>
          )}

          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  );
}
