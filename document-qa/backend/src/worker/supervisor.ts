/**
 * Starts WORKER_COUNT pipeline workers (default 2) as child processes and
 * restarts any that exit, like a container orchestrator would. The chaos
 * switch `kill_mid_chunk` really kills a worker process mid-stage; the
 * supervisor brings it back a second later, and in the meantime the broker
 * redelivers its unacked ticket to the other worker.
 *
 * Worker n gets WORKER_ID=worker-n and WORKER_PORT=WORKER_BASE_PORT+n-1
 * (default 3102, 3103).
 * @module worker/supervisor
 */
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { logger } from '../shared/logger.js'

const count = Number(process.env.WORKER_COUNT ?? 2)
const basePort = Number(process.env.WORKER_BASE_PORT ?? 3102)
const entry = join(dirname(fileURLToPath(import.meta.url)), `index${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`)
const children = new Map<number, ChildProcess>()
let stopping = false

function start(n: number): void {
  const child = fork(entry, [], {
    env: { ...process.env, WORKER_ID: `worker-${n}`, WORKER_PORT: String(basePort + n - 1), SERVICE_NAME: `worker-${n}` },
    stdio: 'inherit',
  })
  children.set(n, child)
  child.on('exit', (code, signal) => {
    children.delete(n)
    if (stopping) return
    logger.warn({ worker: `worker-${n}`, code, signal }, 'worker exited; restarting in 1 s')
    setTimeout(() => start(n), 1000)
  })
}

for (let n = 1; n <= count; n++) start(n)
logger.info({ count, basePort }, 'worker supervisor started')

function stop(): void {
  stopping = true
  for (const child of children.values()) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 6000).unref()
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check)
      process.exit(0)
    }
  }, 100)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
