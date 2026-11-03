import { describe, it, expect } from 'vitest';
import { planNewOpportunity, planStageChange, closedAtSql, STAGE_PROBABILITY } from './opportunityStages.js';
import { HttpError } from './accessPolicy.js';

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
}

describe('planStageChange', () => {
  it('applies the stage default probability when the stage changes', () => {
    const plan = planStageChange({ currentStage: 'Prospecting', currentProbability: 10, nextStage: 'Proposal', isAdmin: false });
    expect(plan).toMatchObject({ stage: 'Proposal', probability: 60, closedAt: 'keep', noop: false });
  });

  it('keeps an explicit probability override on open stages', () => {
    const plan = planStageChange({ currentStage: 'Proposal', currentProbability: 60, probability: 75, isAdmin: false });
    expect(plan).toMatchObject({ stage: 'Proposal', probability: 75 });
  });

  it('pins probability on closed stages and stamps closed_at', () => {
    const plan = planStageChange({ currentStage: 'Negotiation', currentProbability: 80, nextStage: 'Closed Won', probability: 50, isAdmin: false });
    expect(plan).toMatchObject({ stage: 'Closed Won', probability: 100, closedAt: 'set' });
    expect(closedAtSql(plan)).toBe('NOW()');
  });

  it('treats dropping a card on its own column as a no-op', () => {
    const plan = planStageChange({ currentStage: 'Closed Won', currentProbability: 100, nextStage: 'Closed Won', isAdmin: false });
    expect(plan.noop).toBe(true);
  });

  it('refuses to let a rep reopen or flip a closed deal (409)', () => {
    expect(statusOf(() => planStageChange({ currentStage: 'Closed Won', currentProbability: 100, nextStage: 'Prospecting', isAdmin: false }))).toBe(409);
    expect(statusOf(() => planStageChange({ currentStage: 'Closed Won', currentProbability: 100, nextStage: 'Closed Lost', isAdmin: false }))).toBe(409);
  });

  it('lets an admin reopen a closed deal and clears closed_at', () => {
    const plan = planStageChange({ currentStage: 'Closed Lost', currentProbability: 0, nextStage: 'Negotiation', isAdmin: true });
    expect(plan).toMatchObject({ stage: 'Negotiation', probability: 80, closedAt: 'clear' });
    expect(closedAtSql(plan)).toBe('NULL');
  });

  it('rejects unknown stages and out-of-range probabilities (400)', () => {
    expect(statusOf(() => planStageChange({ currentStage: 'Proposal', currentProbability: 60, nextStage: 'Won', isAdmin: true }))).toBe(400);
    expect(statusOf(() => planStageChange({ currentStage: 'Proposal', currentProbability: 60, probability: 101, isAdmin: true }))).toBe(400);
    expect(statusOf(() => planStageChange({ currentStage: 'Proposal', currentProbability: 60, probability: 12.5, isAdmin: true }))).toBe(400);
  });
});

describe('planNewOpportunity', () => {
  it('defaults to Prospecting at its probability', () => {
    expect(planNewOpportunity(undefined, undefined)).toMatchObject({ stage: 'Prospecting', probability: 10, closedAt: 'keep' });
  });

  it('gives a deal created as Closed Won 100% and a closed_at (not the old blanket 10%)', () => {
    expect(planNewOpportunity('Closed Won', undefined)).toMatchObject({ probability: STAGE_PROBABILITY['Closed Won'], closedAt: 'set' });
  });

  it('uses the stage default when no probability is given', () => {
    expect(planNewOpportunity('Negotiation', '')).toMatchObject({ probability: 80 });
  });
});
