/**
 * URL Shortener Component
 *
 * Main form for creating shortened URLs.
 * Supports both basic URL shortening and advanced options (custom codes, expiration).
 */
import React, { useState } from 'react';
import { useUrlStore } from '../stores/urlStore';

/**
 * URL shortening form with advanced options.
 * Displays the created short URL on success with copy functionality.
 */
export function UrlShortener() {
  const [longUrl, setLongUrl] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expiresIn, setExpiresIn] = useState('');

  const { createUrl, createdUrl, isLoading, error, clearCreatedUrl, clearError } = useUrlStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    clearCreatedUrl();

    const data: { long_url: string; custom_code?: string; expires_in?: number } = {
      long_url: longUrl,
    };

    if (customCode.trim()) {
      data.custom_code = customCode.trim();
    }

    if (expiresIn) {
      data.expires_in = parseInt(expiresIn, 10) * 24 * 60 * 60; // Convert days to seconds
    }

    const success = await createUrl(data);
    if (success) {
      setLongUrl('');
      setCustomCode('');
      setExpiresIn('');
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="card max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Shorten a URL</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="longUrl" className="block text-sm font-medium text-gray-700 mb-1">
            Long URL
          </label>
          <input
            id="longUrl"
            type="url"
            value={longUrl}
            onChange={(e) => setLongUrl(e.target.value)}
            placeholder="https://example.com/very/long/url"
            className="input"
            required
          />
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-sm text-primary-600 hover:text-primary-700"
        >
          {showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
        </button>

        {showAdvanced && (
          <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
            <div>
              <label htmlFor="customCode" className="block text-sm font-medium text-gray-700 mb-1">
                Custom Short Code (optional)
              </label>
              <input
                id="customCode"
                type="text"
                value={customCode}
                onChange={(e) => setCustomCode(e.target.value)}
                placeholder="my-custom-link"
                className="input"
                pattern="[a-zA-Z0-9_-]+"
                minLength={4}
                maxLength={20}
              />
              <p className="text-xs text-gray-500 mt-1">
                4-20 characters. Letters, numbers, underscores, and hyphens only.
              </p>
            </div>

            <div>
              <label htmlFor="expiresIn" className="block text-sm font-medium text-gray-700 mb-1">
                Expires in (days, optional)
              </label>
              <input
                id="expiresIn"
                type="number"
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.target.value)}
                placeholder="30"
                className="input"
                min="1"
                max="365"
              />
            </div>
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-50 text-red-700 rounded-lg">
            {error}
          </div>
        )}

        <button type="submit" className="btn btn-primary w-full" disabled={isLoading}>
          {isLoading ? 'Creating...' : 'Shorten URL'}
        </button>
      </form>

      {createdUrl && (
        <div className="mt-6 p-4 bg-green-50 rounded-lg">
          <h3 className="text-lg font-semibold text-green-800 mb-2">URL Shortened!</h3>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={createdUrl.short_url}
              readOnly
              className="input flex-1 bg-white"
            />
            <button
              onClick={() => copyToClipboard(createdUrl.short_url)}
              className="btn btn-secondary"
            >
              Copy
            </button>
          </div>
          <p className="text-sm text-gray-600 mt-2">
            Original: <a href={createdUrl.long_url} target="_blank" rel="noopener noreferrer" className="link break-all">
              {createdUrl.long_url}
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
