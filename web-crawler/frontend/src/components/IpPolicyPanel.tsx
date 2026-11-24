/**
 * @fileoverview Per-IP politeness and CDN exemptions (admins only).
 *
 * Shows the per-IP delay, statically configured exempt ranges, and the status
 * of each published-list source (count, last fetch, last error). Ranges are
 * configured with CRAWLER_IP_EXEMPT_CIDRS / CRAWLER_IP_EXEMPT_SOURCES; this
 * panel is read-only apart from "Refresh now".
 *
 * @module components/IpPolicyPanel
 */

import { useEffect, useState } from 'react';
import type { IpPolicy } from '../types';
import { api } from '../services/api';

export function IpPolicyPanel() {
  const [policy, setPolicy] = useState<IpPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getIpPolicy().then(setPolicy).catch((err) => setError(err.message));
  }, []);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      setPolicy(await api.refreshIpPolicy());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-3">
      <h2 className="text-lg font-medium text-gray-900">Per-IP politeness</h2>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {policy && (
        <>
          <p className="text-sm text-gray-700">
            {policy.ipDelayMs > 0 ? (
              <>
                At most one request every <strong>{policy.ipDelayMs}ms</strong> to any single IP, across all
                domains it hosts.
              </>
            ) : (
              <>Per-IP limit disabled (per-domain politeness only).</>
            )}{' '}
            <strong>{policy.effectiveCount}</strong> exempt range{policy.effectiveCount === 1 ? '' : 's'} (CDNs
            serve unrelated sites from shared IPs; they keep per-domain limits).
          </p>

          {policy.staticCidrs.length > 0 && (
            <p className="text-xs text-gray-600">
              Static: <span className="font-mono">{policy.staticCidrs.join(', ')}</span>
            </p>
          )}

          {policy.sources.length > 0 ? (
            <ul className="text-xs space-y-1">
              {policy.sources.map((s) => (
                <li key={s.url} className="flex flex-wrap gap-x-2">
                  <span className="font-mono text-gray-800 break-all">{s.url}</span>
                  <span className="text-gray-600">
                    {s.count} ranges{s.fetchedAt ? ` · fetched ${new Date(s.fetchedAt).toLocaleString()}` : ' · never fetched'}
                  </span>
                  {s.lastError && <span className="text-amber-800">last error: {s.lastError}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-500">
              No published-list sources configured (set CRAWLER_IP_EXEMPT_SOURCES).
            </p>
          )}

          {policy.sources.length > 0 && (
            <button
              onClick={refresh}
              disabled={busy}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy ? 'Refreshing…' : `Refresh now (auto every ${policy.refreshHours}h)`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
