import { useState } from 'react';
import type { GroupDetail } from '../../types';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Avatar } from '../Avatar';
import { api } from '../../services/api';
import { dollarsToCents, formatCurrency, cx } from '../../utils';
import { ArrowRightIcon } from '../icons';

export interface SettlePrefill {
  from: string;
  to: string;
  amountCents: number;
}

interface SettleUpModalProps {
  open: boolean;
  onClose: () => void;
  group: GroupDetail;
  currentUserId: string;
  prefill?: SettlePrefill | null;
  onSettled: () => void;
}

/** Record a payment between two members (optionally prefilled from a suggested transfer). */
export function SettleUpModal({ open, onClose, group, currentUserId, prefill, onSettled }: SettleUpModalProps) {
  const [fromUser, setFromUser] = useState(prefill?.from || currentUserId);
  const [toUser, setToUser] = useState(
    prefill?.to || group.members.find((m) => m.id !== currentUserId)?.id || ''
  );
  const [amount, setAmount] = useState(prefill ? (prefill.amountCents / 100).toFixed(2) : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const memberName = (id: string) => {
    const m = group.members.find((x) => x.id === id);
    return id === currentUserId ? 'You' : m?.name || m?.username || '?';
  };

  const amountCents = dollarsToCents(amount);
  const canSubmit = fromUser && toUser && fromUser !== toUser && amountCents > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      await api.createSettlement({ groupId: group.id, fromUserId: fromUser, toUserId: toUser, amountCents });
      onSettled();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record payment');
    } finally {
      setSubmitting(false);
    }
  };

  const PersonPicker = ({ value, onChange, label }: { value: string; onChange: (id: string) => void; label: string }) => (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-split-ink">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {group.members.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            className={cx(
              'flex items-center gap-1.5 rounded-xl border px-2 py-1.5 transition',
              value === m.id ? 'border-split-green bg-split-green/10' : 'border-split-line hover:bg-split-bg'
            )}
          >
            <Avatar src={m.avatarUrl} name={m.name || m.username} size="xs" />
            <span className="text-sm font-medium text-split-ink">{m.id === currentUserId ? 'You' : m.name || m.username}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a payment"
      maxWidth="max-w-md"
      footer={
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={handleSubmit} loading={submitting} disabled={!canSubmit} className="flex-1">
            Record payment
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Visual from → to summary */}
        <div className="flex items-center justify-center gap-3 bg-split-bg rounded-2xl py-4">
          <div className="flex flex-col items-center gap-1">
            <Avatar name={memberName(fromUser)} size="md" />
            <span className="text-xs font-medium text-split-ink">{memberName(fromUser)}</span>
          </div>
          <div className="flex flex-col items-center text-split-green-dark">
            <span className="text-base font-bold tabular-nums">{amountCents > 0 ? formatCurrency(amountCents) : ''}</span>
            <ArrowRightIcon className="w-6 h-6" />
          </div>
          <div className="flex flex-col items-center gap-1">
            <Avatar name={memberName(toUser)} size="md" />
            <span className="text-xs font-medium text-split-ink">{memberName(toUser)}</span>
          </div>
        </div>

        <PersonPicker value={fromUser} onChange={setFromUser} label="Who paid" />
        <PersonPicker value={toUser} onChange={setToUser} label="Who received it" />

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

        {fromUser === toUser && <p className="text-split-owe-dark text-sm">Pick two different people.</p>}
        {error && <p className="text-split-owe-dark text-sm text-center">{error}</p>}
      </div>
    </Modal>
  );
}
