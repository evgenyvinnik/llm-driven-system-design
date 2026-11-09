/**
 * Tells the whole story against a live stack with real runners: a green run, a failure with
 * skipped downstream, a re-run with attempts, a deploy held for approval, a runner killed during
 * an idempotent job and during a deploy, a fork pull request with its secrets withheld, a
 * duplicate delivery and a rejected workflow. It leaves those runs behind to look at.
 *
 *   npm run demo:story                     # against http://localhost:3000
 *   API_URL=http://localhost:3010 npm run demo:story
 * @module demo/story
 */
import { DemoClient, waitUntil } from './client.js'

const REPO = process.env.DEMO_REPO ?? 'repo_webapp'
const FINISHED = new Set(['success', 'failure', 'cancelled', 'invalid'])

interface Job {
  id: string
  key: string
  status: string
  attempt: number
  statusReason: string | null
}
interface RunDetail {
  run: { id: string; number: number; status: string; commitMessage: string }
  jobs: Job[]
}
interface Trigger {
  runId: string
  deliveryId: string
  duplicate: boolean
  httpStatus: number
}

const client = new DemoClient()
const results: [string, string][] = []
const getRun = (id: string) => client.get<RunDetail>(`/runs/${id}`)
const trigger = (scenario: string, killOnStep = false) => client.post<Trigger>('/fixtures/trigger', { repoId: REPO, scenario, killOnStep })
const finish = (id: string) => waitUntil(`run ${id} to finish`, async () => ((await getRun(id)).run.status && FINISHED.has((await getRun(id)).run.status) ? getRun(id) : false))
const job = (detail: RunDetail, key: string) => detail.jobs.find((j) => j.key === key) as Job
const untilJob = (runId: string, key: string, status: string) => waitUntil(`${key} to be ${status}`, async () => (job(await getRun(runId), key)?.status === status ? job(await getRun(runId), key) : false))
const note = (what: string, detail: RunDetail) => results.push([what, `run #${detail.run.number} ${detail.run.status}: /runs/${detail.run.id}`])
const runnersBack = () => waitUntil('the runners to be back online', async () => (await client.get<{ runners: { online: boolean; pid: number | null }[] }>('/runners')).runners.filter((r) => r.online && r.pid).length >= 2)

await client.login('alice')

console.log('A green run, then the same webhook delivered again')
const green = await trigger('diamond')
const again = await client.post<Trigger>('/fixtures/redeliver', { repoId: REPO, deliveryId: green.deliveryId })
console.log(`  delivery ${green.deliveryId}: first HTTP ${green.httpStatus}; again HTTP ${again.httpStatus}, duplicate=${again.duplicate}, same run=${again.runId === green.runId}`)
note('success, delivered twice', await finish(green.runId))

console.log('A failing test')
const failing = await trigger('failing')
note('failure, downstream skipped', await finish(failing.runId))

console.log('A flaky test, re-run')
const flaky = await trigger('flaky')
await finish(flaky.runId)
await client.post(`/runs/${flaky.runId}/rerun`, { mode: 'failed' })
const flakyDone = await finish(flaky.runId)
console.log(`  after re-run failed: ${flakyDone.jobs.map((j) => `${j.key}=attempt ${j.attempt}`).join(', ')}`)
note('re-run failed, new attempts', flakyDone)

console.log('A bad signature')
const bad = await client.post<{ httpStatus: number }>('/fixtures/bad-signature', { repoId: REPO })
console.log(`  HTTP ${bad.httpStatus}`)

console.log('A rejected workflow')
const cycle = await trigger('cycle')
note('invalid: dependency cycle', await getRun(cycle.runId))

console.log('A fork pull request')
const fork = await trigger('fork-pr')
const forkDone = await finish(fork.runId)
console.log(`  ${job(forkDone, 'sneak-deploy').statusReason}`)
note('fork PR: secrets withheld, environment denied', forkDone)

console.log('A runner killed during an idempotent build')
await runnersBack()
const killable = await trigger('killable', true)
const killableDone = await finish(killable.runId)
console.log(`  long-build ended on attempt ${job(killableDone, 'long-build').attempt}`)
note('runner killed: lease expired, new attempt', killableDone)

console.log('A deploy held for approval (left waiting)')
await runnersBack()
const held = await trigger('deploy')
const waiting = await untilJob(held.runId, 'deploy', 'waiting')
console.log(`  ${waiting.statusReason}`)
note('waiting for approval', await getRun(held.runId))

console.log('A deploy whose runner dies during the non-idempotent step (left for a person)')
const unknown = await trigger('deploy', true)
const deploy = await untilJob(unknown.runId, 'deploy', 'waiting')
await client.post(`/jobs/${deploy.id}/approval`, { decision: 'approved', comment: 'Release window is open' })
const attention = await untilJob(unknown.runId, 'deploy', 'needs_attention')
console.log(`  ${attention.statusReason}`)
note('needs attention: outcome unknown', await getRun(unknown.runId))

console.log('\nResults:')
for (const [what, where] of results) console.log(`  ${what.padEnd(46)} ${where}`)
