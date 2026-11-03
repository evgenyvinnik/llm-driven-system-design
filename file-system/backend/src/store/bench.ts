/**
 * `npm run bench` (needs PostgreSQL): measures write throughput with and without
 * a shared top-level directory. Every write updates its ancestors' totals while
 * holding their row locks, so writers under one top-level directory queue on it.
 * A user's writes also queue, on the user's row, by design (see pg-backend.ts).
 * Uses the test database, which it wipes.
 */
import { createTestPgBackend } from './pg-test-store.js'

const WORKERS = Number(process.env.WORKERS ?? 20)
const PER_WORKER = Number(process.env.PER_WORKER ?? 100)
const backend = await createTestPgBackend()

async function run(label: string, pathFor: (worker: number, i: number) => string, ownerFor = (w: number) => `u${w}`) {
  await backend.clear()
  for (let w = 0; w < WORKERS; w++) await backend.addUser(`u${w}`, 1e12)
  const started = performance.now()
  await Promise.all(
    Array.from({ length: WORKERS }, async (_, w) => {
      for (let i = 0; i < PER_WORKER; i++) await backend.addFile(pathFor(w, i), 1000, ownerFor(w))
    }),
  )
  const seconds = (performance.now() - started) / 1000
  console.log(`${label.padEnd(44)} ${Math.round((WORKERS * PER_WORKER) / seconds)} writes/s`)
}

console.log(`${WORKERS} concurrent writers, ${PER_WORKER} file creates each`)
await run('Separate top-level dirs (/u7/f12)', (w, i) => `/u${w}/f${i}`)
await run('One shared top-level dir (/home/u7/f12)', (w, i) => `/home/u${w}/f${i}`)
await run('Shared dir three levels up (/a/b/home/u7/f12)', (w, i) => `/a/b/home/u${w}/f${i}`)
await run('Separate dirs, but every write by one user', (w, i) => `/u${w}/f${i}`, () => 'u0')
await backend.close()
