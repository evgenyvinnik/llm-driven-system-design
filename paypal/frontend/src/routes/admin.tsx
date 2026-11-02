import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { adminApi } from '../services/api';
import type { ReconciliationReport } from '../types';
import { formatCents } from '../utils/money';

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start space-x-3 py-2">
      <span className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-xs text-white ${ok ? 'bg-paypal-success' : 'bg-paypal-danger'}`}>
        {ok ? '✓' : '!'}
      </span>
      <div>
        <div className="text-sm font-medium text-paypal-text">{label}</div>
        <div className="text-xs text-paypal-secondary">{detail}</div>
      </div>
    </div>
  );
}

/** Admin ledger reconciliation: proves balances, ledger, and platform cash agree. */
function AdminPage() {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const navigate = useNavigate();
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && !user) navigate({ to: '/login' });
  }, [user, loading, navigate]);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    adminApi
      .reconciliation()
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load report'));
  }, [user]);

  if (loading || !user) {
    return <div className="flex items-center justify-center min-h-[60vh] text-paypal-secondary">Loading...</div>;
  }

  if (user.role !== 'admin') {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-paypal-text mb-2">Ledger Reconciliation</h1>
        <p className="text-paypal-secondary">Admin access required.</p>
      </div>
    );
  }

  const s = report?.summary;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-paypal-text">Ledger Reconciliation</h1>
        {report && (
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${report.balanced ? 'bg-green-50 text-paypal-success' : 'bg-red-50 text-paypal-danger'}`}>
            {report.balanced ? 'Balanced' : 'Discrepancy found'}
          </span>
        )}
      </div>

      {error && <div className="bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm mb-4">{error}</div>}
      {!report && !error && <div className="text-paypal-secondary">Loading report...</div>}

      {report && s && (
        <>
          <div className="bg-white rounded-xl shadow-sm border border-paypal-border p-6 mb-6">
            <Check
              ok={s.totalDebitsCents === s.totalCreditsCents}
              label="Debits equal credits"
              detail={`${formatCents(s.totalDebitsCents)} debited, ${formatCents(s.totalCreditsCents)} credited across all wallets`}
            />
            <Check
              ok={s.unbalancedTransactions === 0 && s.transactionsWithoutEntries === 0}
              label="Every transaction nets to zero"
              detail={`${s.unbalancedTransactions} unbalanced, ${s.transactionsWithoutEntries} without ledger entries`}
            />
            <Check
              ok={s.walletsWithDrift === 0}
              label="Every balance matches its ledger"
              detail={`${s.walletsWithDrift} wallet(s) drifted from the sum of their entries`}
            />
            <Check
              ok={s.customerTotalCents === s.platformCashCents}
              label="Customer balances equal platform cash"
              detail={`${formatCents(s.customerTotalCents)} owed to customers, ${formatCents(s.platformCashCents)} held`}
            />
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-paypal-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paypal-bg text-paypal-secondary text-left">
                <tr>
                  <th className="px-4 py-3 font-medium">Account</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium text-right">Entries</th>
                  <th className="px-4 py-3 font-medium text-right">Stored balance</th>
                  <th className="px-4 py-3 font-medium text-right">Ledger balance</th>
                  <th className="px-4 py-3 font-medium text-right">Drift</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-paypal-border">
                {report.wallets.map((w) => (
                  <tr key={w.walletId}>
                    <td className="px-4 py-3 text-paypal-text">
                      {w.displayName || w.username}
                      <span className="text-paypal-secondary"> @{w.username}</span>
                    </td>
                    <td className="px-4 py-3 text-paypal-secondary">
                      {w.accountType === 'platform_cash' ? 'Platform cash (debit-normal)' : 'Customer'}
                    </td>
                    <td className="px-4 py-3 text-right text-paypal-secondary">{w.entries}</td>
                    <td className="px-4 py-3 text-right">{formatCents(w.balanceCents)}</td>
                    <td className="px-4 py-3 text-right">{formatCents(w.ledgerBalanceCents)}</td>
                    <td className={`px-4 py-3 text-right font-medium ${w.driftCents === 0 ? 'text-paypal-success' : 'text-paypal-danger'}`}>
                      {formatCents(w.driftCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});
