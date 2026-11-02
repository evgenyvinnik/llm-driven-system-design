import { HttpError } from './accessPolicy.js';

/**
 * The pipeline as a small state machine. Both write paths (the kanban
 * `PUT /:id/stage` and the full `PUT /:id`) plan their change here, so they
 * cannot disagree about probability or about which moves are legal.
 */
export const VALID_STAGES = [
  'Prospecting',
  'Qualification',
  'Needs Analysis',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
] as const;

export type Stage = (typeof VALID_STAGES)[number];

export const STAGE_PROBABILITY: Record<Stage, number> = {
  Prospecting: 10,
  Qualification: 20,
  'Needs Analysis': 40,
  Proposal: 60,
  Negotiation: 80,
  'Closed Won': 100,
  'Closed Lost': 0,
};

export function isValidStage(value: unknown): value is Stage {
  return typeof value === 'string' && (VALID_STAGES as readonly string[]).includes(value);
}

export function isClosedStage(stage: string): boolean {
  return stage === 'Closed Won' || stage === 'Closed Lost';
}

export interface StagePlan {
  stage: Stage;
  probability: number;
  /** What to do with closed_at: stamp it now, clear it, or leave it alone. */
  closedAt: 'set' | 'clear' | 'keep';
  /** True when nothing would change, so the caller can skip the write. */
  noop: boolean;
}

function invalidStage(): HttpError {
  return new HttpError(400, `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}`);
}

/**
 * Validates and resolves a stage/probability change.
 *
 * - Open stages may move to any stage.
 * - A closed deal (Won or Lost) is final for reps: reopening it, or flipping Won
 *   to Lost, needs an admin. Deals do reopen in real CRMs, so this is gated
 *   rather than forbidden; without the gate, an accidental kanban drag silently
 *   put booked revenue back into the open pipeline.
 * - Closed stages pin probability (100 / 0); an override is only meaningful for
 *   open deals. Changing stage without an explicit probability applies the
 *   stage's default, so a deal can't end up "Closed Won at 10%".
 * - closed_at is stamped on entering a closed stage and cleared on leaving it;
 *   the revenue report books a deal in the month it closed, not the month it
 *   was last edited.
 */
export function planStageChange(input: {
  currentStage: string;
  currentProbability: number;
  nextStage?: unknown;
  probability?: unknown;
  isAdmin: boolean;
}): StagePlan {
  const { currentStage, currentProbability, isAdmin } = input;

  if (input.nextStage !== undefined && input.nextStage !== null && !isValidStage(input.nextStage)) {
    throw invalidStage();
  }
  const stage = (input.nextStage as Stage | undefined) ?? (currentStage as Stage);
  const stageChanged = stage !== currentStage;

  if (stageChanged && isClosedStage(currentStage) && !isAdmin) {
    throw new HttpError(409, `${currentStage} opportunities can only be reopened or changed by an admin`);
  }

  let requested: number | undefined;
  if (input.probability !== undefined && input.probability !== null && input.probability !== '') {
    const n = typeof input.probability === 'string' ? Number(input.probability) : input.probability;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100) {
      throw new HttpError(400, 'Probability must be a whole number between 0 and 100');
    }
    requested = n;
  }

  let probability: number;
  if (isClosedStage(stage)) {
    probability = STAGE_PROBABILITY[stage];
  } else if (requested !== undefined) {
    probability = requested;
  } else if (stageChanged) {
    probability = STAGE_PROBABILITY[stage];
  } else {
    probability = currentProbability;
  }

  let closedAt: StagePlan['closedAt'] = 'keep';
  if (stageChanged && isClosedStage(stage)) closedAt = 'set';
  else if (stageChanged && isClosedStage(currentStage)) closedAt = 'clear';

  return {
    stage,
    probability,
    closedAt,
    noop: !stageChanged && probability === currentProbability,
  };
}

/** Stage and probability for a new opportunity (default Prospecting, stage default probability). */
export function planNewOpportunity(stage: unknown, probability: unknown): StagePlan {
  const initial = stage === undefined || stage === null || stage === '' ? 'Prospecting' : stage;
  if (!isValidStage(initial)) throw invalidStage();
  const plan = planStageChange({
    currentStage: initial,
    currentProbability: STAGE_PROBABILITY[initial],
    probability,
    isAdmin: true,
  });
  return { ...plan, closedAt: isClosedStage(initial) ? 'set' : 'keep', noop: false };
}

/** SQL expression for the new closed_at value under a plan. */
export function closedAtSql(plan: StagePlan): string {
  if (plan.closedAt === 'set') return 'NOW()';
  if (plan.closedAt === 'clear') return 'NULL';
  return 'closed_at';
}
