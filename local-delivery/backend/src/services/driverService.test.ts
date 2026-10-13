import { describe, it, expect } from 'vitest';
import { scoreDriver, SCORE_WEIGHTS } from './driverService.js';

describe('scoreDriver', () => {
  it('weights sum to 1, so a perfect idle courier at the merchant scores 1', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1);
    expect(scoreDriver({ id: 'd', distance: 0, rating: 5, acceptance_rate: 1 }, 0).total_score).toBeCloseTo(1);
  });

  it('prefers a reliable courier slightly farther away over a closer one who ignores offers', () => {
    const close = scoreDriver({ id: 'close', distance: 0.5, rating: 4.9, acceptance_rate: 0.2 }, 0);
    const reliable = scoreDriver({ id: 'reliable', distance: 1.5, rating: 4.9, acceptance_rate: 1 }, 0);
    expect(reliable.total_score).toBeGreaterThan(close.total_score);
  });

  it('coerces the strings pg returns for DECIMAL columns', () => {
    const score = scoreDriver(
      { id: 'd', distance: 1, rating: '4.50' as unknown as number, acceptance_rate: '0.8000' as unknown as number },
      1
    );
    expect(typeof score.total_score).toBe('number');
    expect(score.factors.rating).toBeCloseTo(0.9);
    expect(score.factors.acceptance_rate).toBeCloseTo(0.8);
  });
});
