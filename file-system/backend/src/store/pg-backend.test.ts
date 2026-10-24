/**
 * Races against the PostgreSQL backend: the guarantees the in-memory answer gets
 * for free from running one call at a time. Runs with `npm run test:pg`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { PgBackend } from './pg-backend.js'

const enabled = process.env.FS_STORE === 'postgres'

let backend: PgBackend

beforeEach(async () => {
  if (!enabled) return
  const { createTestPgBackend } = await import('./pg-test-store.js')
  backend = await createTestPgBackend()
})

/** Every derived number must equal what the files say. */
async function expectInvariants() {
  const pool = (backend as unknown as { pool: import('pg').Pool }).pool
  const checks: Record<string, string> = {
    dirSizes: `SELECT d.path FROM fs_nodes d
               CROSS JOIN LATERAL (SELECT COALESCE(sum(f.size), 0) AS bytes, count(*) AS n
                                   FROM fs_nodes f WHERE f.kind = 'file' AND f.path LIKE d.path || '/%') s
               WHERE d.kind = 'dir' AND (d.size <> s.bytes OR d.file_count <> s.n)`,
    emptyDirs: `SELECT path FROM fs_nodes WHERE kind = 'dir' AND file_count = 0`,
    usedBytes: `SELECT u.id FROM fs_users u WHERE u.used <>
                 (SELECT COALESCE(sum(size), 0) FROM fs_nodes WHERE owner_id = u.id AND kind = 'file')`,
    fileBelowFile: `SELECT f.path FROM fs_nodes f JOIN fs_nodes a ON f.path LIKE a.path || '/%' WHERE a.kind = 'file'`,
    missingParent: `SELECT n.path FROM fs_nodes n WHERE n.parent <> '/' AND NOT EXISTS
                     (SELECT 1 FROM fs_nodes p WHERE p.path = n.parent AND p.kind = 'dir')`,
  }
  for (const [name, sql] of Object.entries(checks)) {
    const { rows } = await pool.query(sql)
    expect(rows, name).toEqual([])
  }
}

async function settle(tasks: Array<() => Promise<unknown>>) {
  return Promise.allSettled(tasks.map((task) => task()))
}

describe.skipIf(!enabled)('PgBackend under concurrent writes', () => {
  it('lets exactly one of many writers create the same path', async () => {
    const results = await settle(Array.from({ length: 20 }, (_, i) => () => backend.addFile('/race/same', i, null)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    await expectInvariants()
  })

  it('never lets a path become both a file and a directory', async () => {
    for (let round = 0; round < 15; round++) {
      const results = await settle([
        () => backend.addFile(`/r${round}/a`, 1, null),
        () => backend.addFile(`/r${round}/a/b`, 1, null),
        () => backend.addFile(`/r${round}/a/b/c`, 1, null),
      ])
      // `a` as a file excludes both others; `a/b` as a file excludes `a/b/c`.
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(2)
    }
    await expectInvariants()
  })

  it('never lets concurrent writes overshoot a quota', async () => {
    await backend.addUser('ana', 100)
    const results = await settle(Array.from({ length: 30 }, (_, i) => () => backend.addFile(`/ana/f${i}`, 10, 'ana')))
    const refused = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    expect(new Set(refused)).toEqual(new Set(['OVER_CAPACITY']))
    await expectInvariants()
  })

  it('keeps directory totals exact while files under one directory change concurrently', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => backend.addFile(`/hot/d${i % 3}/f${i}`, 5, null)))
    await settle([
      ...Array.from({ length: 10 }, (_, i) => () => backend.updateFile(`/hot/d${i % 3}/f${i}`, 7 + i)),
      ...Array.from({ length: 5 }, (_, i) => () => backend.deleteFile(`/hot/d${i % 3}/f${i}`)),
      ...Array.from({ length: 5 }, (_, i) => () => backend.addFile(`/hot/d${i % 3}/g${i}`, 3, null)),
    ])
    await expectInvariants()
  })

  it('finishes merges, restores and writes on the same users without leaving drift', async () => {
    for (const id of ['ana', 'ben', 'cy']) await backend.addUser(id, 1_000)
    for (let i = 0; i < 6; i++) {
      await backend.addFile(`/u/ana/${i}`, 10, 'ana')
      await backend.addFile(`/u/ben/${i}`, 10, 'ben')
    }
    await backend.backupUser('ana')
    await settle([
      () => backend.restoreUser('ana'),
      () => backend.mergeUsers('cy', 'ben'),
      ...Array.from({ length: 6 }, (_, i) => () => backend.updateFile(`/u/ana/${i}`, 20)),
      ...Array.from({ length: 6 }, (_, i) => () => backend.updateFile(`/u/ben/${i}`, 30)),
      () => backend.addFile('/u/ana/new', 5, 'ana'),
    ])
    await expectInvariants()
  })
})
