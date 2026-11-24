/**
 * @fileoverview Audit trail viewer (admins only).
 *
 * Newest first, filtered by action category, paged with "Load older" using the
 * server's keyset cursor (`nextBefore`) - new entries arriving while you read
 * don't shift or duplicate rows, which OFFSET paging would.
 *
 * @module components/AuditLogPanel
 */

import { useCallback, useEffect, useState } from 'react';
import type { AuditEntry } from '../types';
import { api } from '../services/api';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Sign-ins', value: 'auth.' },
  { label: 'Accounts', value: 'user.' },
  { label: 'Frontier', value: 'frontier.' },
  { label: 'Domains', value: 'domain.' },
  { label: 'Other', value: 'stats.' },
];

function formatDetails(entry: AuditEntry): string {
  const parts = Object.entries(entry.details)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return parts.join(' · ');
}

export function AuditLogPanel() {
  const [filter, setFilter] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.getAuditLog({ action: filter || undefined, before });
        setEntries((prev) => (before ? [...prev, ...page.entries] : page.entries));
        setNextBefore(page.nextBefore);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load audit log');
      } finally {
        setLoading(false);
      }
    },
    [filter]
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-3 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium text-gray-900">Audit log</h2>
          <p className="text-sm text-gray-600">
            Every sign-in attempt and every change to crawler state or accounts. Append-only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-700">
            Show{' '}
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="border border-gray-300 rounded-md px-1 py-0.5"
            >
              {FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => load()}
            className="px-2 py-1 text-xs rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase text-gray-500 border-b border-gray-200">
            <tr>
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Who</th>
              <th className="py-2 pr-4">Action</th>
              <th className="py-2 pr-4">Target</th>
              <th className="py-2 pr-4">Details</th>
              <th className="py-2">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {entries.length === 0 && !loading ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-gray-500">
                  No entries
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="py-1.5 pr-4 whitespace-nowrap text-gray-600">{new Date(e.at).toLocaleString()}</td>
                  <td className="py-1.5 pr-4 whitespace-nowrap">{e.actorUsername ?? <span className="text-gray-400">system</span>}</td>
                  <td className="py-1.5 pr-4 whitespace-nowrap">
                    <code className={`text-xs ${e.action.endsWith('.failure') ? 'text-red-700' : 'text-gray-800'}`}>
                      {e.action}
                    </code>
                  </td>
                  <td className="py-1.5 pr-4 whitespace-nowrap text-gray-700">
                    {e.targetType ? `${e.targetType}: ${e.targetId}` : '—'}
                  </td>
                  <td className="py-1.5 pr-4 text-xs text-gray-600 max-w-md break-words">{formatDetails(e) || '—'}</td>
                  <td className="py-1.5 whitespace-nowrap text-xs text-gray-500">{e.ip ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {nextBefore !== null && (
        <button
          onClick={() => load(nextBefore)}
          disabled={loading}
          className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load older'}
        </button>
      )}
    </div>
  );
}
