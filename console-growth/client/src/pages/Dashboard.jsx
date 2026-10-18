import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAppData } from '../lib/appData.jsx';
import { useExperiment } from '../lib/experiments.jsx';
import { formatCents, formatCompact, formatNumber, formatRelative } from '../lib/format.js';

// Example experiment from the starter: the greeting is visible on every Dashboard load, so
// calling the hook here (and auto-logging exposure on mount) is the right place.
function Greeting({ me }) {
  const { isTreatment } = useExperiment('dashboard_welcome_copy');
  const firstName = me?.user.name.split(' ')[0] ?? '';
  return (
    <div className="page-header">
      <h1>Welcome back{firstName ? `, ${firstName}` : ''}</h1>
      <p>{isTreatment && me ? `Here’s what’s happening at ${me.org.name}.` : 'Build with the API: try prompts, create keys, and watch usage.'}</p>
    </div>
  );
}

export default function Dashboard() {
  const { me, billing } = useAppData();
  const [usage, setUsage] = useState(null);
  const [limits, setLimits] = useState(null);
  const [keys, setKeys] = useState(null);

  useEffect(() => {
    api.usage(7).then(setUsage).catch(() => {});
    api.keys().then((data) => setKeys(data.keys)).catch(() => {});
  }, []);

  // A purchase or auto-reload made from this page (e.g. the runway banner) can move the tier.
  const purchasedCents = billing?.cumulativePurchasedCents;
  useEffect(() => {
    api.limits().then(setLimits).catch(() => {});
  }, [purchasedCents]);

  return (
    <>
      <Greeting me={me} />
      <div className="grid grid-4">
        <div className="card">
          <div className="stat-label">Credit balance</div>
          <div className="stat-value">{billing ? formatCents(billing.balanceCents) : '—'}</div>
          <div className="stat-sub">
            <Link to="/settings/billing">Add credits</Link>
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Spend, last 7 days</div>
          <div className="stat-value">{usage ? formatCents(usage.totals.costCents) : '—'}</div>
          <div className="stat-sub">
            <Link to="/usage">View usage</Link>
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Requests, last 7 days</div>
          <div className="stat-value">{usage ? formatNumber(usage.totals.requests) : '—'}</div>
          <div className="stat-sub">{usage ? `${formatCompact(usage.totals.inputTokens + usage.totals.outputTokens)} tokens` : ''}</div>
        </div>
        <div className="card">
          <div className="stat-label">Usage tier</div>
          <div className="stat-value">{limits ? limits.tier.name : '—'}</div>
          <div className="stat-sub">
            <Link to="/limits">View limits</Link>
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Get started</h2>
          <div className="stack" style={{ gap: 10 }}>
            <div className="row">
              <Link className="btn" to="/workbench">
                Open Workbench
              </Link>
              <span className="muted">Try prompts against any model.</span>
            </div>
            <div className="row">
              <Link className="btn" to="/keys">
                Create an API key
              </Link>
              <span className="muted">Call the API from your code.</span>
            </div>
            <div className="row">
              <Link className="btn" to="/settings/members">
                Invite your team
              </Link>
              <span className="muted">Share keys, usage and billing.</span>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>API keys</h2>
            <Link to="/keys" className="small">
              Manage
            </Link>
          </div>
          {!keys && <div className="muted">Loading…</div>}
          {keys && (
            <table className="table">
              <tbody>
                {keys.slice(0, 4).map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td className="mono muted">{key.hint}</td>
                    <td className="muted">{formatRelative(key.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
