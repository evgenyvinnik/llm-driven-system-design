/**
 * @fileoverview Admin controls for one domain: crawl-delay override and block.
 *
 * Design choices:
 * - **Shows all three delays** — what robots.txt asks for, the operator's
 *   override, and what workers actually use (max of the two) — so nobody has
 *   to guess which one wins.
 * - **Floor = robots.txt delay.** The input's min mirrors the server rule
 *   (effective = max(override, robots)). The client floor is for usability;
 *   the server's max() is the actual guarantee.
 * - **Confirmed, not optimistic.** The row updates only when the server
 *   returns the saved domain — this control changes load on someone else's
 *   server, so "saved" must mean saved.
 *
 * @module components/DomainSettingsPanel
 */

import { useState } from 'react';
import type { Domain } from '../types';
import { api } from '../services/api';

interface Props {
  domain: Domain;
  onSaved: (domain: Domain) => void;
}

export function DomainSettingsPanel({ domain, onSaved }: Props) {
  const robotsDelay = domain.crawlDelay ?? 1;
  const [overrideInput, setOverrideInput] = useState(
    domain.crawlDelayOverride != null ? String(domain.crawlDelayOverride) : ''
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const save = async (settings: { crawlDelay?: number | null; isAllowed?: boolean }, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.updateDomainSettings(domain.domain, settings);
      onSaved(updated);
      setOverrideInput(updated.crawlDelayOverride != null ? String(updated.crawlDelayOverride) : '');
      setMessage({ text: `${done} Takes effect on the next request to this domain.`, ok: true });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Save failed', ok: false });
    } finally {
      setBusy(false);
    }
  };

  const parsed = Number(overrideInput);
  const overrideValid =
    overrideInput.trim() !== '' && Number.isFinite(parsed) && parsed >= robotsDelay && parsed <= 3600;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-gray-700">
        robots.txt asks: <strong>{robotsDelay}s</strong> · override:{' '}
        <strong>{domain.crawlDelayOverride != null ? `${domain.crawlDelayOverride}s` : 'none'}</strong> ·
        effective: <strong>{domain.effectiveCrawlDelay ?? robotsDelay}s</strong>
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-gray-700">Crawl-delay override (seconds)</span>
          <input
            type="number"
            min={robotsDelay}
            max={3600}
            step={0.5}
            value={overrideInput}
            onChange={(e) => setOverrideInput(e.target.value)}
            className="mt-1 block w-32 px-2 py-1 border border-gray-300 rounded-md"
          />
        </label>
        <button
          disabled={busy || !overrideValid}
          onClick={() => save({ crawlDelay: parsed }, 'Override saved.')}
          className="px-3 py-1.5 bg-primary-600 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save override
        </button>
        {domain.crawlDelayOverride != null && (
          <button
            disabled={busy}
            onClick={() => save({ crawlDelay: null }, 'Override removed.')}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            Remove override
          </button>
        )}
        <button
          disabled={busy}
          onClick={() =>
            save(
              { isAllowed: !domain.isAllowed },
              domain.isAllowed ? 'Domain blocked.' : 'Domain unblocked.'
            )
          }
          className={`px-3 py-1.5 rounded-md text-white disabled:opacity-50 ${
            domain.isAllowed ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'
          }`}
        >
          {domain.isAllowed ? 'Block domain' : 'Unblock domain'}
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Overrides can only slow crawling down — never below what robots.txt asks for.
      </p>

      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-green-700' : 'text-red-700'}>
          {message.text}
        </p>
      )}
    </div>
  );
}
