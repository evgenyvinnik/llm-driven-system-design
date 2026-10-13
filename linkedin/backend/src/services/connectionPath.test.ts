import { describe, it, expect, vi } from 'vitest';
import { findConnectionPath } from './connectionPath.js';

describe('findConnectionPath', () => {
  const noBridge = vi.fn().mockResolvedValue(null);

  it('returns 1st degree when the target is in the viewer set', async () => {
    const result = await findConnectionPath(1, 2, [2, 3], [1], noBridge);
    expect(result).toEqual({ degree: 1, mutualIds: [], pathIds: [1, 2] });
  });

  it('returns 2nd degree with every mutual and a path through the lowest-id mutual', async () => {
    const result = await findConnectionPath(1, 9, [2, 3, 4], [4, 3, 8], noBridge);
    expect(result.degree).toBe(2);
    expect(result.mutualIds).toEqual([3, 4]);
    expect(result.pathIds).toEqual([1, 3, 9]);
  });

  it('asks for a bridge only when the sets do not intersect, and builds a 4-member path', async () => {
    const bridge = vi.fn().mockResolvedValue([2, 6]);
    const result = await findConnectionPath(1, 8, [2, 3], [6], bridge);
    expect(bridge).toHaveBeenCalledWith([2, 3], [6]);
    expect(result).toEqual({ degree: 3, mutualIds: [], pathIds: [1, 2, 6, 8] });
  });

  it('returns null when no bridge exists', async () => {
    const result = await findConnectionPath(1, 9, [2], [8], noBridge);
    expect(result).toEqual({ degree: null, mutualIds: [], pathIds: [] });
  });

  it('skips the database probe when either side has no connections', async () => {
    const bridge = vi.fn();
    await findConnectionPath(1, 9, [], [8], bridge);
    await findConnectionPath(1, 9, [2], [], bridge);
    expect(bridge).not.toHaveBeenCalled();
  });
});
