import { useEffect, useState } from 'react';
import { api } from '../api.js';
import BarChart from '../components/BarChart.jsx';
import RateLimitUpgradeNudge from '../experiments/RateLimitUpgradeNudge.jsx';
import { formatCents, formatCompact, formatNumber } from '../lib/format.js';

const RANGES = [7, 14, 21];

export default function Usage() {
  const [days, setDays] = useState(7);
  const [usage, setUsage] = useState(null);
  const [limits, setLimits] = useState(null);

  useEffect(() => {
    api.usage(days).then(setUsage).catch(() => {});
  }, [days]);

  useEffect(() => {
    api.limits().then(setLimits).catch(() => {});
  }, []);

  const totals = usage?.totals;
  const rateLimitedShare = totals && totals.requests > 0 ? (totals.rateLimited / (totals.requests + totals.rateLimited)) * 100 : 0;

  return (
    <>
      <div className="page-header row">
        <div>
          <h1>Usage</h1>
          <p>Requests, tokens and cost across all API keys and the Workbench.</p>
        </div>
        <span className="spacer" />
        <div className="row">
          {RANGES.map((range) => (
            <button key={range} type="button" className={`btn btn-sm${range === days ? ' selected' : ''}`} onClick={() => setDays(range)}>
              {range} days
            </button>
          ))}
        </div>
      </div>

      <RateLimitUpgradeNudge limits={limits} />
      {!usage && <div className="muted">Loading…</div>}
      {usage && (
        <div className="stack">
          <div className="grid grid-4">
            <div className="card">
              <div className="stat-label">Cost</div>
              <div className="stat-value">{formatCents(totals.costCents)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Requests</div>
              <div className="stat-value">{formatNumber(totals.requests)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Tokens (in / out)</div>
              <div className="stat-value">
                {formatCompact(totals.inputTokens)} / {formatCompact(totals.outputTokens)}
              </div>
            </div>
            <div className="card">
              <div className="stat-label">Rate-limited (429)</div>
              <div className="stat-value">{formatNumber(totals.rateLimited)}</div>
              <div className="stat-sub">{rateLimitedShare.toFixed(1)}% of requests</div>
            </div>
          </div>

          <div className="card">
            <h2>Daily cost</h2>
            <BarChart data={usage.daily} valueKey="costCents" formatValue={formatCents} />
          </div>

          <div className="grid grid-2">
            <div className="card">
              <h2>Rate-limited requests per day</h2>
              <BarChart data={usage.daily} valueKey="rateLimited" formatValue={formatNumber} variant="secondary" />
            </div>
            <div className="card">
              <h2>By model</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Requests</th>
                    <th className="num">Tokens</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.map((row) => (
                    <tr key={row.model}>
                      <td>{row.name}</td>
                      <td className="num">{formatNumber(row.requests)}</td>
                      <td className="num">{formatCompact(row.inputTokens + row.outputTokens)}</td>
                      <td className="num">{formatCents(row.costCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
