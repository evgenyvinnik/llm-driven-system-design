/**
 * @fileoverview Admin route component for crawler administration.
 *
 * The Admin panel provides administrative controls for the web crawler:
 * - Add seed URLs to start crawling new sites
 * - Recover stale URLs stuck in "in_progress" state
 * - Reset statistics counters
 * - Clear the entire URL frontier (danger zone)
 * - Check system health (database and Redis connectivity)
 *
 * This page is intended for operators who need to manage crawler behavior
 * and recover from error conditions.
 *
 * @module routes/Admin
 */

import { useState } from 'react';
import { api } from '../services/api';

/**
 * Admin route component for crawler administration tasks.
 *
 * Provides four main sections:
 * 1. Seed URLs - Add high-priority URLs to start crawling new domains
 * 2. Recovery Actions - Recover stale URLs that got stuck
 * 3. Statistics - Reset crawl counters
 * 4. Danger Zone - Destructive operations like clearing the frontier
 *
 * All actions show loading state and result feedback.
 *
 * @returns Admin panel with crawler management controls
 */
export function Admin() {
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [seedUrls, setSeedUrls] = useState('');

  /**
   * Generic action handler with loading state and result feedback.
   * Wraps any async action with consistent error handling.
   *
   * @param action - Identifier for the action (used for loading state)
   * @param fn - Async function to execute
   */
  const handleAction = async (action: string, fn: () => Promise<unknown>) => {
    setLoading(action);
    setResult(null);
    try {
      const res = await fn();
      setResult(`Success: ${JSON.stringify(res)}`);
    } catch (error) {
      setResult(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(null);
    }
  };

  /**
   * Handles adding seed URLs from the textarea.
   * Parses the textarea content, filters valid URLs, and submits to API.
   * Seed URLs are added with high priority (3) by default.
   */
  const handleAddSeeds = async () => {
    const urls = seedUrls
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.startsWith('http'));
    if (urls.length === 0) {
      setResult('Error: No valid URLs provided');
      return;
    }
    await handleAction('addSeeds', () => api.addSeedUrls(urls, 3));
    setSeedUrls('');
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>

      {/* Result Message */}
      {result && (
        <div
          className={`p-4 rounded-lg ${
            result.startsWith('Success')
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {result}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Seed URLs */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Add Seed URLs</h2>
          <p className="text-sm text-gray-600 mb-4">
            Add high-priority seed URLs to start crawling new sites.
          </p>
          <textarea
            value={seedUrls}
            onChange={(e) => setSeedUrls(e.target.value)}
            rows={5}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm mb-4"
            placeholder="https://example.com&#10;https://another-site.com"
          />
          <button
            onClick={handleAddSeeds}
            disabled={loading === 'addSeeds'}
            className="px-4 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
          >
            {loading === 'addSeeds' ? 'Adding...' : 'Add Seed URLs'}
          </button>
        </div>

        {/* Recovery Actions */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Recovery Actions</h2>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-600 mb-2">
                Recover stale URLs that have been in progress for too long.
              </p>
              <button
                onClick={() => handleAction('recover', () => api.recoverStaleUrls(10))}
                disabled={loading === 'recover'}
                className="px-4 py-2 bg-yellow-500 text-white rounded-md text-sm font-medium hover:bg-yellow-600 disabled:opacity-50"
              >
                {loading === 'recover' ? 'Recovering...' : 'Recover Stale URLs'}
              </button>
            </div>
          </div>
        </div>

        {/* Statistics Actions */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Statistics</h2>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-600 mb-2">Reset all crawl statistics counters.</p>
              <button
                onClick={() => handleAction('resetStats', api.resetStats)}
                disabled={loading === 'resetStats'}
                className="px-4 py-2 bg-gray-500 text-white rounded-md text-sm font-medium hover:bg-gray-600 disabled:opacity-50"
              >
                {loading === 'resetStats' ? 'Resetting...' : 'Reset Statistics'}
              </button>
            </div>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="bg-white rounded-lg shadow-sm border border-red-200 p-4">
          <h2 className="text-lg font-medium text-red-700 mb-4">Danger Zone</h2>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-red-600 mb-2">
                Clear the entire URL frontier. This action cannot be undone.
              </p>
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      'Are you sure you want to clear the frontier? This cannot be undone.'
                    )
                  ) {
                    handleAction('clearFrontier', api.clearFrontier);
                  }
                }}
                disabled={loading === 'clearFrontier'}
                className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {loading === 'clearFrontier' ? 'Clearing...' : 'Clear Frontier'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* System Health */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <h2 className="text-lg font-medium text-gray-900 mb-4">System Health</h2>
        <button
          onClick={async () => {
            setLoading('health');
            try {
              const health = await api.getHealth();
              setResult(
                `Health: ${health.status} | Database: ${health.services.database} | Redis: ${health.services.redis}`
              );
            } catch (error) {
              setResult(`Error: ${error instanceof Error ? error.message : 'Failed to check health'}`);
            } finally {
              setLoading(null);
            }
          }}
          disabled={loading === 'health'}
          className="px-4 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
        >
          {loading === 'health' ? 'Checking...' : 'Check Health'}
        </button>
      </div>
    </div>
  );
}
