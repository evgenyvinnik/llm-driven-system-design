import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/elasticsearch.js', () => ({ isSearchAvailable: vi.fn(), searchUsers: vi.fn() }));
vi.mock('./userService.js', () => ({ getUsersByIds: vi.fn() }));
vi.mock('../utils/metrics.js', () => ({ searchFallbacksTotal: { inc: vi.fn() } }));

import { query } from '../utils/db.js';
import { isSearchAvailable, searchUsers } from '../utils/elasticsearch.js';
import { getUsersByIds } from './userService.js';
import { toPrefixQuery, searchPeople } from './searchService.js';

describe('toPrefixQuery', () => {
  it('builds an AND of prefix terms from letters and digits only', () => {
    expect(toPrefixQuery('Data  Sci')).toBe('data:* & sci:*');
    expect(toPrefixQuery("dev' | !x:* <-> (y)")).toBe('dev:* & x:* & y:*');
    expect(toPrefixQuery('  ')).toBeNull();
  });
});

describe('searchPeople', () => {
  it('uses Elasticsearch when available and keeps its relevance order', async () => {
    vi.mocked(isSearchAvailable).mockReturnValue(true);
    vi.mocked(searchUsers).mockResolvedValue([3, 1]);
    vi.mocked(getUsersByIds).mockResolvedValue([{ id: 3 }, { id: 1 }] as never);
    const result = await searchPeople('alice', 5);
    expect(result.source).toBe('elasticsearch');
    expect(getUsersByIds).toHaveBeenCalledWith([3, 1]);
  });

  it('falls back to PostgreSQL full-text when Elasticsearch throws', async () => {
    vi.mocked(isSearchAvailable).mockReturnValue(true);
    vi.mocked(searchUsers).mockRejectedValue(new Error('connect ECONNREFUSED'));
    vi.mocked(query).mockResolvedValue([{ id: 10 }] as never);
    const result = await searchPeople('developer', 5);
    expect(result).toEqual({ users: [{ id: 10 }], source: 'postgres' });
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(['developer:*', 'developer', 5]);
  });

  it('skips Elasticsearch entirely while it is marked unavailable', async () => {
    vi.mocked(isSearchAvailable).mockReturnValue(false);
    vi.mocked(searchUsers).mockClear();
    vi.mocked(query).mockResolvedValue([] as never);
    await searchPeople('x', 5);
    expect(searchUsers).not.toHaveBeenCalled();
  });
});
