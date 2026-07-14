import { useMemo, useState } from 'react';
import type { GroupDetail, SplitType } from '../../types';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Input } from '../Input';
import { Avatar } from '../Avatar';
import { SplitEditor } from './SplitEditor';
import { computeOwed, type ParticipantState } from './splitState';
import { api } from '../../services/api';
import { dollarsToCents, formatCurrency } from '../../utils';

interface AddExpenseModalProps {
  open: boolean;
  onClose: () => void;
  group: GroupDetail;
  currentUserId: string;
  onCreated: () => void;
}

const CATEGORIES = ['general', 'food', 'groceries', 'housing', 'utilities', 'transport', 'entertainment', 'household'];

function initialState(group: GroupDetail): Record<string, ParticipantState> {
  const s: Record<string, ParticipantState> = {};
  for (const m of group.members) {
    s[m.id] = { selected: true, exact: '', percent: '', shares: '1' };
  }
  return s;
}

/** Full "add an expense" flow: amount, payer, category, and the split editor. */
export function AddExpenseModal({ open, onClose, group, currentUserId, onCreated }: AddExpenseModalProps) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState(currentUserId);
  const [category, setCategory] = useState('general');
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [state, setState] = useState<Record<string, ParticipantState>>(() => initialState(group));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const totalCents = dollarsToCents(amount);
  const { error: splitError } = useMemo(
    () => computeOwed(group.members, totalCents, splitType, state),
    [group.members, totalCents, splitType, state]
  );

  const canSubmit = description.trim().length > 0 && totalCents > 0 && !splitError;

  const patchState = (userId: string, patch: Partial<ParticipantState>) =>
    setState((s) => ({ ...s, [userId]: { ...s[userId], ...patch } }));

  const reset = () => {
    setDescription('');
    setAmount('');
    setPaidBy(currentUserId);
    setCategory('general');
    setSplitType('equal');
    setState(initialState(group));
    setError('');
  };

  const handleSubmit = async () => {
    const { owed, error: err } = computeOwed(group.members, totalCents, splitType, state);
    if (err) {
      setError(err);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const participants = group.members
        .filter((m) => state[m.id]?.selected)
        .map((m) => {
          const st = state[m.id];
          if (splitType === 'exact') return { userId: m.id, amountCents: owed[m.id] };
          if (splitType === 'percentage') return { userId: m.id, percentage: parseFloat(st.percent || '0') || 0 };
          if (splitType === 'shares') return { userId: m.id, shares: parseInt(st.shares || '0') || 0 };
          return { userId: m.id };
        });

      await api.createExpense({
        groupId: group.id,
        description: description.trim(),
        amountCents: totalCents,
        paidBy,
        splitType,
        category,
        participants,
      });
      reset();
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add expense');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add an expense"
      footer={
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={handleSubmit} loading={submitting} disabled={!canSubmit} className="flex-1">
            Save expense
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Input
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Dinner, groceries, rent…"
          autoFocus
        />

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-split-ink">Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-split-ink-soft">$</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="input-field pl-7 text-lg font-semibold"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-split-ink">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input-field capitalize"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c} className="capitalize">{c}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Paid by */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-split-ink">Paid by</label>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {group.members.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setPaidBy(m.id)}
                className={`flex items-center gap-2 rounded-xl border px-2.5 py-1.5 shrink-0 transition ${
                  paidBy === m.id ? 'border-split-green bg-split-green/10' : 'border-split-line hover:bg-split-bg'
                }`}
              >
                <Avatar src={m.avatarUrl} name={m.name || m.username} size="xs" />
                <span className="text-sm font-medium text-split-ink">
                  {m.id === currentUserId ? 'You' : (m.name || m.username)}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Split editor */}
        <div className="pt-1">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-split-ink">Split</label>
            <span className="text-sm font-bold text-split-ink tabular-nums">
              {totalCents > 0 ? formatCurrency(totalCents) : '$0.00'}
            </span>
          </div>
          <SplitEditor
            members={group.members}
            totalCents={totalCents}
            splitType={splitType}
            onSplitTypeChange={setSplitType}
            state={state}
            onStateChange={patchState}
          />
        </div>

        {error && <p className="text-split-owe-dark text-sm text-center">{error}</p>}
      </div>
    </Modal>
  );
}
