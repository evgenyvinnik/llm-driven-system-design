import { useState } from 'react';
import type { GroupBalances, GroupMember } from '../../types';
import { Avatar } from '../Avatar';
import { Button } from '../Button';
import { formatAbs, cx } from '../../utils';
import { ArrowRightIcon, SparklesIcon, ScaleIcon } from '../icons';
import type { SettlePrefill } from '../expense/SettleUpModal';

interface BalancesPanelProps {
  balances: GroupBalances;
  members: GroupMember[];
  currentUserId: string;
  onSettle: (prefill: SettlePrefill) => void;
}

/**
 * Two views over the same numbers:
 *  - "Balances": each member's net position (raw, derived).
 *  - "Simplify": the minimal set of transfers to zero everyone out.
 * The toggle makes the value of debt-simplification tangible — you can see the
 * tangle of individual positions collapse into a few clean payments.
 */
export function BalancesPanel({ balances, members, currentUserId, onSettle }: BalancesPanelProps) {
  const [view, setView] = useState<'net' | 'simplify'>('net');

  const nameOf = (id: string) => {
    const m = members.find((x) => x.id === id);
    return id === currentUserId ? 'You' : m?.name || m?.username || '?';
  };
  const memberOf = (id: string) => members.find((x) => x.id === id);

  const allSettled = balances.net.every((n) => n.netCents === 0);

  return (
    <div className="card overflow-hidden">
      {/* Toggle */}
      <div className="flex bg-split-bg m-3 rounded-xl p-1">
        <button
          onClick={() => setView('net')}
          className={cx('flex-1 flex items-center justify-center gap-1.5 text-sm font-semibold py-1.5 rounded-lg transition',
            view === 'net' ? 'bg-white text-split-ink shadow-sm' : 'text-split-ink-soft')}
        >
          <ScaleIcon className="w-4 h-4" /> Balances
        </button>
        <button
          onClick={() => setView('simplify')}
          className={cx('flex-1 flex items-center justify-center gap-1.5 text-sm font-semibold py-1.5 rounded-lg transition',
            view === 'simplify' ? 'bg-white text-split-ink shadow-sm' : 'text-split-ink-soft')}
        >
          <SparklesIcon className="w-4 h-4" /> Simplify debts
        </button>
      </div>

      {allSettled ? (
        <div className="px-4 py-8 text-center text-split-ink-soft">
          <p className="text-2xl mb-1">🎉</p>
          <p className="font-medium text-split-ink">Everyone's settled up</p>
          <p className="text-sm">No outstanding balances in this group.</p>
        </div>
      ) : view === 'net' ? (
        <div className="divide-y divide-split-line">
          {balances.net
            .slice()
            .sort((a, b) => b.netCents - a.netCents)
            .map((n) => (
              <div key={n.userId} className="flex items-center gap-3 px-4 py-3">
                <Avatar src={n.avatarUrl} name={n.name || n.username} size="sm" />
                <span className="flex-1 text-sm font-medium text-split-ink">
                  {n.userId === currentUserId ? 'You' : n.name || n.username}
                </span>
                {n.netCents === 0 ? (
                  <span className="text-sm text-split-ink-soft">settled up</span>
                ) : (
                  <span className={cx('text-sm font-semibold', n.netCents > 0 ? 'text-split-green-dark' : 'text-split-owe-dark')}>
                    {n.netCents > 0 ? 'gets back ' : 'owes '}
                    {formatAbs(n.netCents)}
                  </span>
                )}
              </div>
            ))}
        </div>
      ) : (
        <div>
          <p className="px-4 pb-2 text-xs text-split-ink-soft">
            {balances.simplified.length} payment{balances.simplified.length === 1 ? '' : 's'} settles the whole group.
          </p>
          <div className="divide-y divide-split-line">
            {balances.simplified.map((t, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <Avatar src={memberOf(t.from)?.avatarUrl} name={nameOf(t.from)} size="sm" />
                <div className="flex-1 flex items-center gap-2 text-sm">
                  <span className="font-medium text-split-ink">{nameOf(t.from)}</span>
                  <ArrowRightIcon className="w-4 h-4 text-split-ink-soft" />
                  <span className="font-medium text-split-ink">{nameOf(t.to)}</span>
                </div>
                <span className="text-sm font-bold text-split-ink tabular-nums">{formatAbs(t.amountCents)}</span>
                <Button
                  variant="outline"
                  onClick={() => onSettle({ from: t.from, to: t.to, amountCents: t.amountCents })}
                  className="!py-1.5 !px-3 text-xs"
                >
                  Settle
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
