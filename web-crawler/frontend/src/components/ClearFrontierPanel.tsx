/**
 * @fileoverview Danger-zone control for clearing the frontier.
 *
 * Friction is proportional to irreversibility: this is the one action that
 * can't be undone, so it requires typing CLEAR and shows how many URLs will
 * be deleted. (A browser confirm() dialog is clicked through by reflex.)
 *
 * @module components/ClearFrontierPanel
 */

import { useState } from 'react';
import { api } from '../services/api';

const CONFIRM_WORD = 'CLEAR';

interface Props {
  /** Pending + in-progress URLs that would be deleted (from the stats snapshot) */
  queuedCount: number | null;
  onResult: (message: string, ok: boolean) => void;
}

export function ClearFrontierPanel({ queuedCount, onResult }: Props) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const handleClear = async () => {
    setBusy(true);
    try {
      await api.clearFrontier();
      onResult('Frontier cleared.', true);
      setTyped('');
    } catch (error) {
      onResult(`Clear failed: ${error instanceof Error ? error.message : 'Unknown error'}`, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-red-200 p-4">
      <h2 className="text-lg font-medium text-red-700 mb-2">Danger Zone</h2>
      <p className="text-sm text-gray-700 mb-3">
        Clear the entire URL frontier
        {queuedCount !== null && (
          <>
            {' '}
            — <strong>{queuedCount.toLocaleString()}</strong> queued URLs will be deleted
          </>
        )}
        . Crawled-page records are kept. This cannot be undone.
      </p>
      <label className="block text-sm text-gray-700 mb-2">
        Type <code className="font-mono font-semibold">{CONFIRM_WORD}</code> to confirm
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono"
          aria-label={`Type ${CONFIRM_WORD} to confirm clearing the frontier`}
        />
      </label>
      <button
        onClick={handleClear}
        disabled={typed !== CONFIRM_WORD || busy}
        className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? 'Clearing…' : 'Clear Frontier'}
      </button>
    </div>
  );
}
