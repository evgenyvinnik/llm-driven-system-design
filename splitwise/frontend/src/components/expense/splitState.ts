import type { GroupMember, SplitType } from '../../types';
import { allocateByWeights, formatCurrency, dollarsToCents } from '../../utils';

/** Per-member input state for the split editor (only one field matters per split type). */
export interface ParticipantState {
  selected: boolean;
  exact: string; // dollar string for exact split
  percent: string; // percentage string
  shares: string; // integer share string
}

/**
 * Resolve the current split state into per-user owed cents plus a validation
 * message. Pure and cheap so it can run on every keystroke — the editor shows
 * exactly what each person will owe, and why a split doesn't add up, before
 * saving. Uses the same largest-remainder allocation as the backend, so the
 * preview equals what the server will store.
 */
export function computeOwed(
  members: GroupMember[],
  totalCents: number,
  splitType: SplitType,
  state: Record<string, ParticipantState>
): { owed: Record<string, number>; error: string | null } {
  const selected = members.filter((m) => state[m.id]?.selected);
  if (selected.length === 0) return { owed: {}, error: 'Select at least one person' };
  if (totalCents <= 0) return { owed: {}, error: 'Enter an amount' };

  const owed: Record<string, number> = {};

  if (splitType === 'equal') {
    const cents = allocateByWeights(totalCents, selected.map(() => 1));
    selected.forEach((m, i) => (owed[m.id] = cents[i]));
    return { owed, error: null };
  }

  if (splitType === 'exact') {
    let sum = 0;
    selected.forEach((m) => {
      const c = dollarsToCents(state[m.id].exact || '0');
      owed[m.id] = c;
      sum += c;
    });
    if (sum !== totalCents) {
      const diff = totalCents - sum;
      return { owed, error: `${formatCurrency(Math.abs(diff))} ${diff > 0 ? 'left to assign' : 'over'}` };
    }
    return { owed, error: null };
  }

  if (splitType === 'percentage') {
    const pcts = selected.map((m) => parseFloat(state[m.id].percent || '0') || 0);
    const sum = pcts.reduce((a, b) => a + b, 0);
    const cents = allocateByWeights(totalCents, pcts);
    selected.forEach((m, i) => (owed[m.id] = cents[i]));
    if (Math.abs(sum - 100) > 0.01) {
      return { owed, error: `Percentages add up to ${sum.toFixed(0)}% (need 100%)` };
    }
    return { owed, error: null };
  }

  // shares
  const weights = selected.map((m) => parseInt(state[m.id].shares || '0') || 0);
  if (weights.some((w) => w <= 0)) return { owed: {}, error: 'Each person needs at least 1 share' };
  const cents = allocateByWeights(totalCents, weights);
  selected.forEach((m, i) => (owed[m.id] = cents[i]));
  return { owed, error: null };
}
