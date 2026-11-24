/**
 * @fileoverview Admin route component for crawler administration.
 *
 * Shows a sign-in form until an admin session exists (every action here hits a
 * route the server protects with `requireAdmin`). Once signed in:
 * - Add seed URLs (validated client-side before submitting)
 * - Recover stale URLs stuck in "in_progress"
 * - Reset statistics counters
 * - Clear the frontier (typed confirmation)
 * - Check system health
 *
 * @module routes/Admin
 */

import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useCrawlerStore } from '../stores/crawlerStore';
import { LoginForm } from '../components/LoginForm';
import { ClearFrontierPanel } from '../components/ClearFrontierPanel';

type Result = { message: string; ok: boolean } | null;

/**
 * Splits pasted text into valid http(s) URLs and the lines that aren't.
 */
function parseSeedUrls(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      const u = new URL(line);
      if (u.protocol === 'http:' || u.protocol === 'https:') valid.push(line);
      else invalid.push(line);
    } catch {
      invalid.push(line);
    }
  }
  return { valid, invalid };
}

export function Admin() {
  const user = useAuthStore((s) => s.user);
  const checking = useAuthStore((s) => s.checking);
  const { stats, fetchStats } = useCrawlerStore();
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [seedText, setSeedText] = useState('');

  const isAdmin = user?.role === 'admin';

  // The danger zone shows how many URLs a clear would delete
  useEffect(() => {
    if (isAdmin && !stats) fetchStats();
  }, [isAdmin, stats, fetchStats]);

  const run = async (action: string, fn: () => Promise<string>) => {
    setLoading(action);
    setResult(null);
    try {
      setResult({ message: await fn(), ok: true });
    } catch (error) {
      setResult({ message: error instanceof Error ? error.message : 'Unknown error', ok: false });
    } finally {
      setLoading(null);
      fetchStats(); // counts shown here (e.g. the danger zone) must reflect the action
    }
  };

  const { valid: seedUrls, invalid: invalidSeeds } = parseSeedUrls(seedText);

  if (checking) {
    return <div className="p-6 text-sm text-gray-500">Checking session…</div>;
  }

  if (!isAdmin) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>
        <LoginForm />
      </div>
    );
  }

  const card = 'bg-white rounded-lg shadow-sm border border-gray-200 p-4';
  const button =
    'px-4 py-2 text-white rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>

      {result && (
        <div
          role={result.ok ? 'status' : 'alert'}
          className={`p-4 rounded-lg border ${
            result.ok
              ? 'bg-green-50 text-green-800 border-green-200'
              : 'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          {result.message}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={card}>
          <h2 className="text-lg font-medium text-gray-900 mb-2">Add Seed URLs</h2>
          <p className="text-sm text-gray-600 mb-3">
            One URL per line. Seeds are queued at high priority, depth 0.
          </p>
          <textarea
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            rows={5}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-2"
            placeholder={'https://example.com\nhttps://another-site.com'}
            aria-label="Seed URLs, one per line"
          />
          {invalidSeeds.length > 0 && (
            <p className="text-sm text-amber-800 mb-2">
              {invalidSeeds.length} line(s) aren't valid http(s) URLs and will be skipped:{' '}
              <span className="font-mono">{invalidSeeds.slice(0, 3).join(', ')}</span>
              {invalidSeeds.length > 3 && '…'}
            </p>
          )}
          <button
            onClick={() =>
              run('seed', async () => {
                const res = await api.addSeedUrls(seedUrls, 3);
                setSeedText('');
                const skipped = res.total - res.added;
                return `Added ${res.added} of ${res.total} URLs${
                  skipped ? ` (${skipped} already known or filtered)` : ''
                }.`;
              })
            }
            disabled={loading === 'seed' || seedUrls.length === 0}
            className={`${button} bg-primary-600 hover:bg-primary-700`}
          >
            {loading === 'seed'
              ? 'Adding…'
              : seedUrls.length > 0
                ? `Add ${seedUrls.length} Seed URL${seedUrls.length === 1 ? '' : 's'}`
                : 'Add Seed URLs'}
          </button>
        </div>

        <div className={card}>
          <h2 className="text-lg font-medium text-gray-900 mb-2">Recovery &amp; Statistics</h2>
          <p className="text-sm text-gray-600 mb-3">
            Stale leases are recovered automatically every minute; this forces a sweep now for
            URLs in progress longer than 10 minutes.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() =>
                run('recover', async () => {
                  const res = await api.recoverStaleUrls(10);
                  return `Recovered ${res.recovered} stale URL(s).`;
                })
              }
              disabled={loading === 'recover'}
              className={`${button} bg-yellow-600 hover:bg-yellow-700`}
            >
              {loading === 'recover' ? 'Recovering…' : 'Recover Stale URLs'}
            </button>
            <button
              onClick={() =>
                run('reset', async () => {
                  if (!window.confirm('Reset all crawl counters to zero? Crawl data is kept.')) {
                    return 'Reset cancelled.';
                  }
                  await api.resetStats();
                  return 'Statistics counters reset.';
                })
              }
              disabled={loading === 'reset'}
              className={`${button} bg-gray-600 hover:bg-gray-700`}
            >
              {loading === 'reset' ? 'Resetting…' : 'Reset Statistics'}
            </button>
            <button
              onClick={() =>
                run('health', async () => {
                  const h = await api.getHealth();
                  const services = Object.entries(h.services)
                    .map(([name, svc]) => `${name}: ${svc.status}${svc.latencyMs !== undefined ? ` (${svc.latencyMs}ms)` : ''}`)
                    .join(' · ');
                  return `System ${h.status} — ${services} · workers: ${h.workers ?? 0}`;
                })
              }
              disabled={loading === 'health'}
              className={`${button} bg-primary-600 hover:bg-primary-700`}
            >
              {loading === 'health' ? 'Checking…' : 'Check Health'}
            </button>
          </div>
        </div>

        <ClearFrontierPanel
          queuedCount={stats ? stats.frontierPending + stats.frontierInProgress : null}
          onResult={(message, ok) => {
            setResult({ message, ok });
            fetchStats();
          }}
        />
      </div>
    </div>
  );
}
