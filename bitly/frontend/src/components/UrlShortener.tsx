/**
 * URL Shortener Component
 *
 * Main form for creating shortened URLs.
 * Supports both basic URL shortening and advanced options (custom codes, expiration).
 */
import React, { useRef, useState } from 'react';
import { useUrlStore } from '../stores/urlStore';
import { CreateUrlInput } from '../types';
import { createIdempotencyKey } from '../utils/id';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';

/**
 * URL shortening form with advanced options.
 * Displays the created short URL on success with copy functionality.
 */
export function UrlShortener() {
  const [longUrl, setLongUrl] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expiresIn, setExpiresIn] = useState('');

  /**
   * Idempotency-Key of the draft last submitted. Retrying the same draft (e.g. after a
   * network error, when the first attempt may have succeeded on the server) reuses it, so
   * the server replays the original link instead of creating a second one. Any edit to the
   * draft, or a success, starts a new key.
   */
  const draftKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const resultInput = useRef<HTMLInputElement>(null);

  const { createUrl, createdUrl, isCreating, createError, clearCreatedUrl, clearCreateError } = useUrlStore();
  const { copy, status: copyStatus } = useCopyToClipboard();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearCreateError();
    clearCreatedUrl();

    const data: CreateUrlInput = {
      long_url: longUrl.trim(),
    };

    if (customCode.trim()) {
      data.custom_code = customCode.trim();
    }

    if (expiresIn) {
      data.expires_in = parseInt(expiresIn, 10) * 24 * 60 * 60; // Convert days to seconds
    }

    const fingerprint = JSON.stringify(data);
    if (draftKey.current?.fingerprint !== fingerprint) {
      draftKey.current = { fingerprint, key: createIdempotencyKey() };
    }

    const success = await createUrl(data, draftKey.current.key);
    if (success) {
      draftKey.current = null;
      setLongUrl('');
      setCustomCode('');
      setExpiresIn('');
    }
  };

  const handleCopy = async (text: string) => {
    const ok = await copy(text);
    if (!ok) {
      // Make manual copying one keystroke away
      resultInput.current?.select();
    }
  };

  return (
    <div className="card max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Shorten a URL</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Locked while submitting, so the draft that succeeds is the one that gets cleared */}
        <fieldset disabled={isCreating} className="space-y-4">
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
                  placeholder="my-link"
                  className="input"
                  pattern="[a-zA-Z0-9_-]+"
                  minLength={4}
                  maxLength={10}
                />
                <p className="text-xs text-gray-500 mt-1">
                  4-10 characters. Letters, numbers, underscores, and hyphens only.
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
        </fieldset>

        {createError && (
          <div className="p-4 bg-red-50 text-red-700 rounded-lg">
            {createError}
          </div>
        )}

        <button type="submit" className="btn btn-primary w-full" disabled={isCreating}>
          {isCreating ? 'Creating...' : 'Shorten URL'}
        </button>
      </form>

      {createdUrl && (
        <div className="mt-6 p-4 bg-green-50 rounded-lg">
          <h3 className="text-lg font-semibold text-green-800 mb-2">URL Shortened!</h3>
          <div className="flex items-center gap-2">
            <input
              ref={resultInput}
              type="text"
              value={createdUrl.short_url}
              readOnly
              className="input flex-1 bg-white"
            />
            <button
              onClick={() => handleCopy(createdUrl.short_url)}
              className="btn btn-secondary"
            >
              {copyStatus === 'copied' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {copyStatus === 'failed' && (
            <p className="text-sm text-red-600 mt-2" role="alert">
              Could not copy automatically. The link is selected - press Ctrl+C (Cmd+C) to copy it.
            </p>
          )}
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
