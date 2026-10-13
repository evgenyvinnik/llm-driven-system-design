import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() }));
vi.mock('../utils/elasticsearch.js', () => ({
  indexUser: vi.fn(),
  indexJob: vi.fn(),
  deleteSearchDocument: vi.fn(),
  isSearchAvailable: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../utils/metrics.js', () => ({ searchIndexOperationsTotal: { inc: vi.fn() } }));

import { query, queryOne, execute } from '../utils/db.js';
import { indexUser, deleteSearchDocument, isSearchAvailable } from '../utils/elasticsearch.js';
import { processSearchIndexBatch, backoffSeconds } from './searchIndexer.js';

const claimedRow = { entity_type: 'user', entity_id: 7, version: '3', attempts: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isSearchAvailable).mockReturnValue(true);
  vi.mocked(execute).mockResolvedValue(1);
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (sql.includes('UPDATE search_index_queue')) return [claimedRow] as never;
    if (sql.includes('FROM user_skills')) return [{ name: 'React' }] as never;
    return [{ company_name: 'TechCorp' }] as never;
  });
  vi.mocked(queryOne).mockResolvedValue({ id: 7, first_name: 'Ivan', last_name: 'Novak', headline: null } as never);
});

describe('processSearchIndexBatch', () => {
  it('rebuilds the document from PostgreSQL and deletes only the claimed version', async () => {
    const result = await processSearchIndexBatch(10);
    expect(result).toEqual({ indexed: 1, failed: 0 });
    expect(indexUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, skills: ['React'], companies: ['TechCorp'], headline: undefined })
    );
    const [sql, params] = vi.mocked(execute).mock.calls[0];
    expect(sql).toContain('DELETE FROM search_index_queue');
    expect(sql).toContain('version = $3');
    expect(params).toEqual(['user', 7, '3']);
  });

  it('keeps the row and backs off when indexing fails', async () => {
    vi.mocked(indexUser).mockRejectedValue(new Error('cluster down'));
    const result = await processSearchIndexBatch(10);
    expect(result).toEqual({ indexed: 0, failed: 1 });
    const [sql, params] = vi.mocked(execute).mock.calls[0];
    expect(sql).toContain('attempts = $4');
    expect(params).toEqual(['user', 7, '3', 1, 'cluster down', 2]);
  });

  it('deletes the search document when the source row is gone', async () => {
    vi.mocked(queryOne).mockResolvedValue(null);
    await processSearchIndexBatch(10);
    expect(deleteSearchDocument).toHaveBeenCalledWith('users', 7);
    expect(indexUser).not.toHaveBeenCalled();
  });

  it('does not claim rows while Elasticsearch is marked unavailable', async () => {
    vi.mocked(isSearchAvailable).mockReturnValue(false);
    expect(await processSearchIndexBatch(10)).toEqual({ indexed: 0, failed: 0 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('backoffSeconds', () => {
  it('doubles per attempt and caps at five minutes', () => {
    expect([1, 2, 3, 8, 9, 30].map(backoffSeconds)).toEqual([2, 4, 8, 256, 300, 300]);
  });
});
