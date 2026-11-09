/**
 * Runs one step as a child process in its own process group: `detached` makes the shell a
 * group leader, so signalling `-pid` reaches everything it started. Handles the timeout,
 * cancel and lease loss, and always clears out whatever the step left running.
 *
 * This is a substitution for a per-job VM or container and it is not a security boundary:
 * a child process shares the runner's filesystem, network and user.
 * @module runner/process
 */
import { spawn } from 'node:child_process'
import { limitsPrefix, type ResourceLimits } from './env.js'

export type StepOutcome = 'success' | 'failure' | 'timed_out' | 'killed'

export interface StepRun {
  /** Kills the whole process group: SIGTERM, then SIGKILL after a grace period. */
  kill: () => void
  done: Promise<{ outcome: StepOutcome; exitCode: number | null }>
  pid: number | undefined
}

export interface StepOptions {
  scriptPath: string
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  limits: ResourceLimits
  onOutput: (text: string) => void
  killGraceMs?: number
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: the group is already gone.
  }
}

export function runStepProcess(options: StepOptions): StepRun {
  const grace = options.killGraceMs ?? 1000
  // A background child can hold stdout open long after the shell exits, so `close` may never come.
  const drainMs = 300
  const child = spawn('/bin/sh', ['-c', limitsPrefix(options.limits), options.scriptPath], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', options.onOutput)
  child.stderr.on('data', options.onOutput)

  let interruption: 'timed_out' | 'killed' | null = null
  const terminate = () => {
    signalGroup(child.pid, 'SIGTERM')
    // Unconditional: a child that ignored SIGTERM must not survive the group leader.
    setTimeout(() => signalGroup(child.pid, 'SIGKILL'), grace).unref()
  }
  const timeout = setTimeout(() => {
    interruption ??= 'timed_out'
    terminate()
  }, options.timeoutMs)
  timeout.unref()

  const done = new Promise<{ outcome: StepOutcome; exitCode: number | null }>((resolve) => {
    let finished = false
    const finish = (code: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      // Whatever the step left behind goes with it.
      signalGroup(child.pid, 'SIGTERM')
      setTimeout(() => signalGroup(child.pid, 'SIGKILL'), grace).unref()
      if (interruption) resolve({ outcome: interruption, exitCode: code })
      else resolve({ outcome: code === 0 ? 'success' : 'failure', exitCode: code })
    }
    child.on('error', (err) => {
      options.onOutput(`failed to start the step: ${err.message}\n`)
      finish(127)
    })
    child.on('close', (code) => finish(code))
    child.on('exit', (code, signal) => {
      setTimeout(() => finish(code ?? (signal ? 128 : null)), drainMs).unref()
    })
  })

  return {
    pid: child.pid,
    done,
    kill: () => {
      interruption ??= 'killed'
      terminate()
    },
  }
}
