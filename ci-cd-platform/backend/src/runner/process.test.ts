import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ClaimedJob } from '../scheduling/claim.js'
import { buildStepEnv, limitsPrefix } from './env.js'
import { runStepProcess } from './process.js'
import { confined, confinedReal, createAttemptDirs, removeAttemptDirs, writeTree } from './workspace.js'

const limits = { cpuSeconds: 30, fileSizeMb: 1, openFiles: 256 }
let dir: string

async function script(name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, body)
  return path
}

function run(scriptPath: string, opts: { timeoutMs?: number; env?: Record<string, string> } = {}) {
  let output = ''
  const handle = runStepProcess({ scriptPath, cwd: dir, env: { PATH: '/usr/bin:/bin', ...opts.env }, timeoutMs: opts.timeoutMs ?? 10_000, limits, onOutput: (t) => (output += t), killGraceMs: 200 })
  return { handle, output: () => output }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!check() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25))
  return check()
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cicd-process-test-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('runStepProcess', () => {
  it('reports exit 0 as success and captures output', async () => {
    const { handle, output } = run(await script('ok.sh', 'echo hello\necho err >&2\n'))
    expect(await handle.done).toEqual({ outcome: 'success', exitCode: 0 })
    expect(output()).toContain('hello')
    expect(output()).toContain('err')
  })

  it('reports non-zero as failure, and sh -e stops at the first failing command', async () => {
    const { handle, output } = run(await script('fail.sh', 'echo before\nfalse\necho after\n'))
    expect((await handle.done).outcome).toBe('failure')
    expect(output()).toContain('before')
    expect(output()).not.toContain('after')
  })

  it('a kill reaches the whole process group, children and grandchildren', async () => {
    const { handle, output } = run(await script('tree.sh', `sleep 60 &\necho child=$!\nsh -c 'sleep 60 & echo grandchild=$!; wait' &\necho shell=$$\nwait\n`))
    await waitFor(() => /grandchild=\d+/.test(output()))
    const pids = [...output().matchAll(/=(\d+)/g)].map((m) => Number(m[1]))
    expect(pids.length).toBe(3)
    expect(pids.every(alive)).toBe(true)
    handle.kill()
    expect((await handle.done).outcome).toBe('killed')
    expect(await waitFor(() => !pids.some(alive))).toBe(true)
  })

  it('SIGKILL follows for a child that ignores SIGTERM', async () => {
    const { handle, output } = run(await script('stubborn.sh', `trap '' TERM\nsh -c 'trap "" TERM; echo stubborn=$$; sleep 60' &\necho leader=$$\nwait\n`))
    await waitFor(() => /stubborn=\d+/.test(output()))
    const pid = Number(/stubborn=(\d+)/.exec(output())?.[1])
    handle.kill()
    await handle.done
    expect(await waitFor(() => !alive(pid))).toBe(true)
  })

  it('times out, killing the group', async () => {
    const { handle, output } = run(await script('slow.sh', 'echo pid=$$\nsleep 60\n'), { timeoutMs: 300 })
    const result = await handle.done
    expect(result.outcome).toBe('timed_out')
    const pid = Number(/pid=(\d+)/.exec(output())?.[1])
    expect(await waitFor(() => !alive(pid))).toBe(true)
  })

  it('clears up a background process the step left running after a normal exit', async () => {
    const { handle, output } = run(await script('bg.sh', 'sleep 60 &\necho orphan=$!\n'))
    expect((await handle.done).outcome).toBe('success')
    const pid = Number(/orphan=(\d+)/.exec(output())?.[1])
    expect(await waitFor(() => !alive(pid))).toBe(true)
  })

  it('does not inherit the parent environment', async () => {
    process.env.CICD_TEST_LEAK = 'leaked-value'
    const { handle, output } = run(await script('env.sh', 'env\n'))
    await handle.done
    delete process.env.CICD_TEST_LEAK
    expect(output()).not.toContain('leaked-value')
    expect(output()).not.toContain('CICD_TEST_LEAK')
  })

  it('applies the file size limit', async () => {
    const { handle, output } = run(await script('big.sh', 'dd if=/dev/zero of=big.bin bs=1048576 count=5\necho wrote-it\n'))
    expect((await handle.done).outcome).toBe('failure')
    expect(output()).not.toContain('wrote-it')
  })
})

describe('buildStepEnv', () => {
  const job = { env: { CI_ATTEMPT: 'spoofed', MY_VAR: 'job' }, secrets: { TOKEN: 'value' }, repository: 'a/b', commitSha: 'sha', ref: 'r', branch: 'b', eventType: 'push', runId: 'run', jobKey: 'k', attempt: 3 } as unknown as ClaimedJob
  const env = buildStepEnv(job, { STEP_VAR: 'step', MY_VAR: 'step' }, { workspace: '/w', artifacts: '/a' })

  it('contains only what was put there', () => {
    expect(env.CICD_MASTER_KEY).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
    expect(Object.keys(env)).not.toContain('NODE_OPTIONS')
  })

  it('a workflow cannot spoof a platform variable', () => {
    expect(env.CI_ATTEMPT).toBe('3')
  })

  it('layers workflow env, step env and secrets', () => {
    expect(env.MY_VAR).toBe('step')
    expect(env.STEP_VAR).toBe('step')
    expect(env.TOKEN).toBe('value')
    expect(env.HOME).toBe('/w')
  })

  it('builds the limits prefix', () => {
    expect(limitsPrefix(limits)).toContain('ulimit -f 2048')
    expect(limitsPrefix(limits)).toContain('exec /bin/sh -e "$0"')
  })
})

describe('workspace', () => {
  it('confines relative paths', () => {
    expect(confined('/w', 'a/b.txt')).toBe('/w/a/b.txt')
    expect(confined('/w', '../etc/passwd')).toBeNull()
    expect(confined('/w', 'a/../../etc/passwd')).toBeNull()
    expect(confined('/w', '/etc/passwd')).toBeNull()
    expect(confined('/w', '.')).toBeNull()
  })

  it('follows a symlink to its real location before trusting it', async () => {
    const dirs = await createAttemptDirs(dir, 'symlink-test')
    await writeFile(join(dirs.workspace, 'real.txt'), 'x')
    execSync(`ln -s /etc/passwd ${join(dirs.workspace, 'sneaky')}`)
    expect(await confinedReal(dirs.workspace, 'real.txt')).toBeTruthy()
    expect(await confinedReal(dirs.workspace, 'sneaky')).toBeNull()
    expect(await confinedReal(dirs.workspace, 'missing.txt')).toBeNull()
    await removeAttemptDirs(dirs)
    expect(existsSync(dirs.root)).toBe(false)
  })

  it('refuses a tree that points outside the workspace', async () => {
    const dirs = await createAttemptDirs(dir, 'tree-test')
    await expect(writeTree(dirs.workspace, { '../escape.txt': 'x' })).rejects.toThrow(/outside the workspace/)
    await writeTree(dirs.workspace, { 'scripts/run.sh': 'echo', 'a.txt': 'y' })
    expect(existsSync(join(dirs.workspace, 'scripts/run.sh'))).toBe(true)
    await removeAttemptDirs(dirs)
  })
})
