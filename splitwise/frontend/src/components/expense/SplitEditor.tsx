import { useMemo } from 'react';
import type { GroupMember, SplitType } from '../../types';
import { Avatar } from '../Avatar';
import { formatCurrency, cx } from '../../utils';
import { computeOwed, type ParticipantState } from './splitState';

interface SplitEditorProps {
  members: GroupMember[];
  totalCents: number;
  splitType: SplitType;
  onSplitTypeChange: (t: SplitType) => void;
  state: Record<string, ParticipantState>;
  onStateChange: (userId: string, patch: Partial<ParticipantState>) => void;
}

const SPLIT_TABS: { type: SplitType; label: string; hint: string }[] = [
  { type: 'equal', label: 'Equally', hint: 'Split the total evenly' },
  { type: 'exact', label: 'Exact', hint: 'Enter each person\'s amount' },
  { type: 'percentage', label: 'Percent', hint: 'Enter each person\'s %' },
  { type: 'shares', label: 'Shares', hint: 'Weight by shares' },
];

/** Split-type tabs + per-member rows with live per-person amounts. */
export function SplitEditor({ members, totalCents, splitType, onSplitTypeChange, state, onStateChange }: SplitEditorProps) {
  const { owed, error } = useMemo(
    () => computeOwed(members, totalCents, splitType, state),
    [members, totalCents, splitType, state]
  );

  const activeTab = SPLIT_TABS.find((t) => t.type === splitType)!;

  return (
    <div className="space-y-3">
      {/* Split-type tabs */}
      <div className="flex bg-split-bg rounded-xl p-1">
        {SPLIT_TABS.map((tab) => (
          <button
            key={tab.type}
            type="button"
            onClick={() => onSplitTypeChange(tab.type)}
            className={cx(
              'flex-1 text-sm font-semibold py-1.5 rounded-lg transition',
              splitType === tab.type ? 'bg-white text-split-ink shadow-sm' : 'text-split-ink-soft hover:text-split-ink'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-split-ink-soft px-0.5">{activeTab.hint}</p>

      {/* Member rows */}
      <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
        {members.map((m) => {
          const st = state[m.id];
          const isSel = st?.selected;
          return (
            <div
              key={m.id}
              className={cx(
                'flex items-center gap-3 rounded-xl px-2.5 py-2 transition',
                isSel ? 'bg-white' : 'opacity-55'
              )}
            >
              <button type="button" onClick={() => onStateChange(m.id, { selected: !isSel })}>
                <Avatar src={m.avatarUrl} name={m.name || m.username} size="sm" />
              </button>
              <button
                type="button"
                onClick={() => onStateChange(m.id, { selected: !isSel })}
                className="flex-1 text-left min-w-0"
              >
                <p className="text-sm font-medium text-split-ink truncate">{m.name || m.username}</p>
              </button>

              {isSel && splitType === 'equal' && (
                <span className="text-sm font-semibold text-split-ink tabular-nums">
                  {owed[m.id] != null ? formatCurrency(owed[m.id]) : '—'}
                </span>
              )}

              {isSel && splitType === 'exact' && (
                <div className="flex items-center gap-1">
                  <span className="text-split-ink-soft text-sm">$</span>
                  <input
                    inputMode="decimal"
                    value={st.exact}
                    onChange={(e) => onStateChange(m.id, { exact: e.target.value })}
                    placeholder="0.00"
                    className="w-20 text-right input-field !py-1.5 !px-2"
                  />
                </div>
              )}

              {isSel && splitType === 'percentage' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-split-ink-soft tabular-nums w-14 text-right">
                    {owed[m.id] != null ? formatCurrency(owed[m.id]) : ''}
                  </span>
                  <input
                    inputMode="decimal"
                    value={st.percent}
                    onChange={(e) => onStateChange(m.id, { percent: e.target.value })}
                    placeholder="0"
                    className="w-16 text-right input-field !py-1.5 !px-2"
                  />
                  <span className="text-split-ink-soft text-sm">%</span>
                </div>
              )}

              {isSel && splitType === 'shares' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-split-ink-soft tabular-nums w-14 text-right">
                    {owed[m.id] != null ? formatCurrency(owed[m.id]) : ''}
                  </span>
                  <input
                    inputMode="numeric"
                    value={st.shares}
                    onChange={(e) => onStateChange(m.id, { shares: e.target.value })}
                    placeholder="1"
                    className="w-14 text-right input-field !py-1.5 !px-2"
                  />
                  <span className="text-split-ink-soft text-xs">shares</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Live validation banner */}
      <div
        className={cx(
          'text-sm font-medium rounded-xl px-3 py-2 text-center',
          error ? 'bg-split-owe/10 text-split-owe-dark' : 'bg-split-green/10 text-split-green-dark'
        )}
      >
        {error || 'Splits add up — ready to save ✓'}
      </div>
    </div>
  );
}
