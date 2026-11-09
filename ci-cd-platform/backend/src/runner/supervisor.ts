/**
 * Keeps the local runner fleet alive, standing in for an autoscaler: a runner that dies
 * (the fixture panel's kill switch uses a real SIGKILL) comes back after a few seconds, so a
 * demo can be repeated. The dead incarnation's leases still have to expire: a new process
 * with the same name does not inherit them.
 * @module runner/supervisor
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./index.ts', import.meta.url))
const count = Number(process.env.RUNNER_COUNT ?? 2)
const basePort = Number(process.env.RUNNER_PORT_BASE ?? 3101)
// Longer than the offline threshold (5 s), so a killed runner visibly goes offline before it returns.
const restartMs = Number(process.env.RUNNER_RESTART_MS ?? 8000)
// The last runner also carries the `deploy` label, so a deploy job has exactly one kind of home.
const labelsFor = (i: number) => (i === count - 1 ? 'linux,x64,deploy' : 'linux,x64')

const children = new Map<number, ChildProcess>()
let stopping = false

function start(i: number): void {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    stdio: 'inherit',
    env: { ...process.env, RUNNER_NAME: `runner-${i + 1}`, RUNNER_LABELS: labelsFor(i), RUNNER_PORT: String(basePort + i), SERVICE_NAME: `runner-${i + 1}` },
  })
  children.set(i, child)
  child.on('exit', (code, signal) => {
    children.delete(i)
    if (stopping) return
    console.log(`[supervisor] runner-${i + 1} exited (code ${code}, signal ${signal}); restarting in ${restartMs} ms`)
    setTimeout(() => start(i), restartMs)
  })
}

for (let i = 0; i < count; i++) start(i)

function shutdown(): void {
  stopping = true
  for (const child of children.values()) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
