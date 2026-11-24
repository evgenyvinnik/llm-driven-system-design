/**
 * @fileoverview Banner that distinguishes "stalled" from "idle".
 *
 * The most dangerous dashboard state is one that looks calm while nothing
 * works. "0 in progress" alone can mean the crawl finished or that every
 * worker is dead. The frontier's status breakdown tells them apart:
 *
 * | Pending | In progress | Workers | Meaning                                 |
 * |---------|-------------|---------|-----------------------------------------|
 * | > 0     | 0           | 0       | Work queued, nothing to do it (stalled)  |
 * | > 0     | 0           | > 0     | Workers alive but idle: every domain     |
 * |         |             |         | politeness-locked, or URLs in backoff    |
 * | 0       | 0           | any     | Crawl finished (idle)                    |
 *
 * @module components/CrawlHealthBanner
 */

import { Link } from '@tanstack/react-router';
import type { CrawlStats } from '../types';

export function CrawlHealthBanner({ stats }: { stats: CrawlStats | null }) {
  if (!stats) return null;

  const pending = stats.frontierPending;
  const inProgress = stats.frontierInProgress;
  const workers = stats.activeWorkers.length;

  if (pending > 0 && inProgress === 0 && workers === 0) {
    return (
      <div role="alert" className="p-4 rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm">
        <strong>Frontier has {pending.toLocaleString()} URLs but no workers are running.</strong>{' '}
        Start workers (<code>npm run dev:worker1</code>) — nothing will be crawled until then.
      </div>
    );
  }

  if (pending > 0 && inProgress === 0) {
    return (
      <div role="status" className="p-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm">
        Workers are running but nothing is in progress. Pending URLs may all be waiting on
        politeness delays or retry backoff — check the{' '}
        <Link to="/frontier" className="underline">
          Frontier
        </Link>{' '}
        for retry counts and errors.
      </div>
    );
  }

  if (pending === 0 && inProgress === 0) {
    return (
      <div role="status" className="p-4 rounded-lg border border-gray-200 bg-gray-50 text-gray-700 text-sm">
        Idle — the frontier is empty.{' '}
        <Link to="/admin" className="underline">
          Add seed URLs
        </Link>{' '}
        to continue crawling.
      </div>
    );
  }

  return null;
}
