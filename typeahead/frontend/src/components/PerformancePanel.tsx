import { useEffect, useState } from 'react';
import { getMetrics, resetMetrics, type TypeaheadMetrics } from '../services/performance';

const REFRESH_MS = 1000;

const formatMs = (ms: number): string => (ms < 10 ? ms.toFixed(1) : Math.round(ms).toString()) + 'ms';
const formatPercent = (ratio: number): string => `${Math.round(ratio * 100)}%`;
// A row with no samples shows a dash rather than a misleading 0
const NO_DATA = '—';

/**
 * Client-side typeahead metrics for this tab: what the search box actually felt like, as
 * opposed to the server-side numbers on the admin dashboard.
 */
export function PerformancePanel() {
  const [metrics, setMetrics] = useState<TypeaheadMetrics>(getMetrics);

  useEffect(() => {
    const timer = window.setInterval(() => setMetrics(getMetrics()), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const handleReset = () => {
    resetMetrics();
    setMetrics(getMetrics());
  };

  const m = metrics;
  const rows: Array<[string, string]> = [
    ['Lookups', m.lookups.toString()],
    ['Answered from tab cache', m.lookups > 0 ? formatPercent(m.cacheHitRate) : NO_DATA],
    ['Requests sent', m.requestsSent.toString()],
    [
      'Network latency p50 / p95',
      m.networkResponses > 0 ? `${formatMs(m.p50LatencyMs)} / ${formatMs(m.p95LatencyMs)}` : NO_DATA,
    ],
    ['Keystroke to suggestions', m.keyToSuggestionSamples > 0 ? formatMs(m.avgKeyToSuggestionMs) : NO_DATA],
    ['Keystroke to selection', m.selectionTimeSamples > 0 ? formatMs(m.avgSelectionTimeMs) : NO_DATA],
    ['Selections', m.selectionsCount.toString()],
    ['Errors', m.errorCount.toString()],
  ];
  const hasData = m.lookups > 0 || m.requestsSent > 0 || m.errorCount > 0 || m.selectionsCount > 0;

  return (
    <section className="bg-white rounded-lg shadow p-4" aria-labelledby="performance-panel-title">
      <div className="flex items-center justify-between mb-3">
        <h3 id="performance-panel-title" className="font-semibold text-gray-800">
          Client Performance
        </h3>
        <button
          type="button"
          onClick={handleReset}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          Reset
        </button>
      </div>

      {!hasData ? (
        <p className="text-sm text-gray-500">Type in the search box to collect metrics for this tab.</p>
      ) : (
        <dl className="space-y-1 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between">
              <dt className="text-gray-600">{label}</dt>
              <dd className="font-mono text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
