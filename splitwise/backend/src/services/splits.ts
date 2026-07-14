/**
 * Split calculation
 *
 * The one rule that governs everything here: the sum of every participant's
 * owed_cents MUST equal the expense total, exactly, to the penny. If it drifts,
 * balances never reconcile and "settle up" can never reach zero.
 *
 * Integer cents make this tractable but expose a rounding problem: $10.00 split
 * three ways is 333.33... cents each. We floor to 333 and then hand out the
 * leftover pennies deterministically (largest-remainder method), so the parts
 * sum back to 1000 rather than 999.
 */

export type SplitType = 'equal' | 'exact' | 'percentage' | 'shares';

export interface ParticipantInput {
  userId: string;
  /** Exact owed cents — required for split_type='exact'. */
  amountCents?: number;
  /** Percentage 0–100 — required for split_type='percentage'. */
  percentage?: number;
  /** Positive integer share weight — required for split_type='shares'. */
  shares?: number;
}

export interface ResolvedSplit {
  userId: string;
  owedCents: number;
  shareUnits: number | null;
  percentage: number | null;
}

export class SplitError extends Error {}

/**
 * Distribute `total` cents across `weights` proportionally using the
 * largest-remainder method. Every entry gets floor(total * w / sumW); the
 * leftover pennies go one-by-one to the entries with the largest fractional
 * remainder. Guarantees Σ result === total. Ties break by original order, so
 * the result is deterministic (important for reproducible balances).
 */
function allocateByWeights(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) throw new SplitError('Split weights must sum to a positive value');

  const base: number[] = [];
  const remainders: { index: number; frac: number }[] = [];
  let allocated = 0;

  weights.forEach((w, i) => {
    const exact = (total * w) / sumW;
    const floor = Math.floor(exact);
    base[i] = floor;
    allocated += floor;
    remainders.push({ index: i, frac: exact - floor });
  });

  let leftover = total - allocated; // number of pennies still to hand out
  remainders.sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; i < remainders.length && leftover > 0; i++) {
    base[remainders[i].index] += 1;
    leftover--;
  }

  return base;
}

/**
 * Resolve a set of participant inputs into concrete owed_cents per user for a
 * given split type. Throws SplitError on any inconsistency (empty participants,
 * exact amounts that don't sum to total, percentages that don't sum to 100).
 */
export function calculateSplits(
  totalCents: number,
  splitType: SplitType,
  participants: ParticipantInput[]
): ResolvedSplit[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new SplitError('Expense amount must be a positive integer number of cents');
  }
  if (participants.length === 0) {
    throw new SplitError('An expense must have at least one participant');
  }
  const ids = new Set(participants.map((p) => p.userId));
  if (ids.size !== participants.length) {
    throw new SplitError('Duplicate participant in split');
  }

  switch (splitType) {
    case 'equal': {
      const owed = allocateByWeights(totalCents, participants.map(() => 1));
      return participants.map((p, i) => ({
        userId: p.userId,
        owedCents: owed[i],
        shareUnits: null,
        percentage: null,
      }));
    }

    case 'exact': {
      const owed = participants.map((p) => {
        if (p.amountCents == null || !Number.isInteger(p.amountCents) || p.amountCents < 0) {
          throw new SplitError('Each participant needs a non-negative integer amount for an exact split');
        }
        return p.amountCents;
      });
      const sum = owed.reduce((a, b) => a + b, 0);
      if (sum !== totalCents) {
        throw new SplitError(
          `Exact split amounts ($${(sum / 100).toFixed(2)}) must sum to the total ($${(totalCents / 100).toFixed(2)})`
        );
      }
      return participants.map((p, i) => ({
        userId: p.userId,
        owedCents: owed[i],
        shareUnits: null,
        percentage: null,
      }));
    }

    case 'percentage': {
      const pcts = participants.map((p) => {
        if (p.percentage == null || p.percentage < 0) {
          throw new SplitError('Each participant needs a non-negative percentage');
        }
        return p.percentage;
      });
      const sum = pcts.reduce((a, b) => a + b, 0);
      // Allow a tiny float tolerance; the actual cents come from allocateByWeights.
      if (Math.abs(sum - 100) > 0.01) {
        throw new SplitError(`Percentages must sum to 100 (got ${sum})`);
      }
      const owed = allocateByWeights(totalCents, pcts);
      return participants.map((p, i) => ({
        userId: p.userId,
        owedCents: owed[i],
        shareUnits: null,
        percentage: pcts[i],
      }));
    }

    case 'shares': {
      const shares = participants.map((p) => {
        if (p.shares == null || !Number.isInteger(p.shares) || p.shares <= 0) {
          throw new SplitError('Each participant needs a positive integer number of shares');
        }
        return p.shares;
      });
      const owed = allocateByWeights(totalCents, shares);
      return participants.map((p, i) => ({
        userId: p.userId,
        owedCents: owed[i],
        shareUnits: shares[i],
        percentage: null,
      }));
    }

    default:
      throw new SplitError(`Unknown split type: ${splitType}`);
  }
}
