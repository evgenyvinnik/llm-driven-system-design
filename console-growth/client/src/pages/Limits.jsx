import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { formatCents, formatDate, formatNumber } from '../lib/format.js';

export default function Limits() {
  const [limits, setLimits] = useState(null);

  useEffect(() => {
    api.limits().then(setLimits).catch(() => {});
  }, []);

  if (!limits) return <div className="muted">Loading…</div>;
  const { tier, nextTier, monthlySpend } = limits;

  return (
    <>
      <div className="page-header">
        <h1>Limits</h1>
        <p>Rate limits and the monthly spend limit for your organization. Limits rise automatically as you move up usage tiers.</p>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="stat-label">Current tier</div>
          <div className="stat-value">{tier.name}</div>
          <div className="stat-sub">{formatCents(limits.cumulativePurchasedCents)} in credits purchased to date</div>
        </div>
        <div className="card">
          <div className="stat-label">Monthly spend limit</div>
          <div className="stat-value">{formatCents(monthlySpend.limitCents)}</div>
          <div className="stat-sub">{formatCents(monthlySpend.usedCents)} used this month</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Rate limits per model</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Requests / min</th>
              <th className="num">Input tokens / min</th>
              <th className="num">Output tokens / min</th>
            </tr>
          </thead>
          <tbody>
            {limits.models.map((row) => (
              <tr key={row.model}>
                <td>{row.name}</td>
                <td className="num">{formatNumber(row.rpm)}</td>
                <td className="num">{formatNumber(row.itpm)}</td>
                <td className="num">{formatNumber(row.otpm)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Usage tiers</h2>
        {nextTier ? (
          <p>
            To reach <strong>{nextTier.name}</strong>, purchase at least {formatCents(nextTier.minPurchasedCents)} in credits in total
            {nextTier.waitDays > 0 ? ` and wait ${nextTier.waitDays} days after your first purchase` : ''}.{' '}
            {nextTier.waitSatisfied ? '' : `You can reach it from ${formatDate(nextTier.eligibleAt)}. `}
            Credits are bought in <Link to="/settings/billing">Billing</Link>.
          </p>
        ) : (
          <p>You’re on the highest self-serve tier. For higher limits, see the Scale plan.</p>
        )}
      </div>
    </>
  );
}
