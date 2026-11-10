/**
 * Fires a burst of signed pushes at one repository, a few at another once the burst is under
 * way, and reports how the work was shared out. Exits non-zero if a per-repository limit was broken.
 *
 *   npm run load:burst                                    # 30 pushes at acme/web-app, 3 at acme/payments-api
 *   BURST_COUNT=60 OTHER_COUNT=5 npm run load:burst
 *   API_URL=http://localhost:3010 npm run load:burst
 *
 * A fleet with free slots proves little: to see fairness rather than spare capacity, run more
 * pushes than the fleet can hold at the burst repository's limit, or raise that limit.
 * @module demo/burst
 */
import { API_URL, DemoClient, sleep, waitUntil } from './client.js'

const BURST_REPO = process.env.BURST_REPO ?? 'repo_webapp'
const OTHER_REPO = process.env.OTHER_REPO ?? 'repo_payments'
const count = Number(process.env.BURST_COUNT ?? 30)
const otherCount = Number(process.env.OTHER_COUNT ?? 3)

interface Trigger {
  runId: string
  httpStatus: number
}
interface ReportRow {
  fullName: string
  limit: number
  jobs: number
  finished: number
  peakConcurrent: number
  waitP50Ms: number
  waitMaxMs: number
}

const client = await new DemoClient().login('alice')
const since = new Date()
const push = (repoId: string) => client.post<Trigger>('/fixtures/trigger', { repoId, scenario: 'burst' })

console.log(`Firing ${count} pushes at ${BURST_REPO} through ${API_URL}`)
const started = Date.now()
const burst = await Promise.all(Array.from({ length: count }, () => push(BURST_REPO)))
console.log(`  intake accepted ${burst.filter((b) => b.httpStatus === 202).length} in ${Date.now() - started} ms`)
await sleep(1000)
console.log(`Firing ${otherCount} pushes at ${OTHER_REPO}, while the burst is still queued`)
const other = await Promise.all(Array.from({ length: otherCount }, () => push(OTHER_REPO)))

const allRuns = [...burst, ...other].map((r) => r.runId)
await waitUntil(
  'every run to finish',
  async () => {
    const report = (await client.get<{ repositories: ReportRow[] }>(`/ops/burst-report?since=${encodeURIComponent(since.toISOString())}`)).repositories
    return report.reduce((n, r) => n + r.finished, 0) >= allRuns.length
  },
  240_000,
  500,
)

const report = (await client.get<{ repositories: ReportRow[] }>(`/ops/burst-report?since=${encodeURIComponent(since.toISOString())}`)).repositories
console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s`)
console.table(report.map((r) => ({ repository: r.fullName, jobs: r.jobs, 'peak / limit': `${r.peakConcurrent} / ${r.limit}`, 'wait p50 (ms)': r.waitP50Ms, 'wait max (ms)': r.waitMaxMs })))
const broken = report.filter((r) => r.peakConcurrent > r.limit)
if (broken.length > 0) {
  console.error(`Limit broken: ${broken.map((r) => r.fullName).join(', ')}`)
  process.exitCode = 1
}
