import { describe, expect, it } from 'vitest'
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from './tools.js'

const reads: string[] = []
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  readFile: async (path) => {
    reads.push(path)
    return path === 'src/a.ts' ? 'export const a = 1' : null
  },
  changedFiles: () => [{ path: 'src/a.ts', previousPath: null, status: 'modified' }],
  callsSoFar: 0,
  maxCalls: 8,
  ...over,
})
const call = (name: string, input: unknown) => ({ id: 't', name, input })

describe('tool allowlist', () => {
  it('offers exactly two tools, neither of which writes', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(['read_file', 'list_changed_files'])
  })

  it('reads an allowed file', async () => {
    const r = await executeTool(call('read_file', { path: 'src/a.ts' }), ctx())
    expect(r).toMatchObject({ allowed: true, result: 'export const a = 1' })
  })

  it('reports a missing file without treating it as a violation', async () => {
    const r = await executeTool(call('read_file', { path: 'src/none.ts' }), ctx())
    expect(r).toMatchObject({ allowed: true, result: 'Not found at this commit' })
  })

  it('lists changed files', async () => {
    const r = await executeTool(call('list_changed_files', {}), ctx())
    expect(r.allowed).toBe(true)
    expect(r.result).toContain('src/a.ts')
  })

  it.each(['approve_pull_request', 'merge_pull_request', 'post_comment', 'run_shell', 'read_file ', 'READ_FILE', '__proto__'])('denies the unknown tool %j', async (name) => {
    const r = await executeTool(call(name, {}), ctx())
    expect(r).toMatchObject({ allowed: false, denialReason: 'unknown_tool' })
  })

  it.each(['.env', '.ENV', '.env.local', 'config/.env', './.env', 'src/../.env', '%2eenv', 'keys/server.pem', 'deploy/id_rsa', '.git/config', '.npmrc', 'secrets/db.txt', 'app/secrets/db.txt', 'aws/credentials'])('denies the secret path %j', async (path) => {
    const before = reads.length
    const r = await executeTool(call('read_file', { path }), ctx())
    expect(r).toMatchObject({ allowed: false, denialReason: 'secret_path' })
    expect(reads.length).toBe(before)
  })

  it.each(['../../etc/passwd', '../outside.txt', '/etc/passwd', 'C:\\Windows\\system.ini', '%2e%2e/%2e%2e/etc/passwd', '..\\..\\etc\\passwd', 'src/a\u0000.ts', 'src/a%00.ts'])('denies the out-of-repo path %j', async (path) => {
    const before = reads.length
    const r = await executeTool(call('read_file', { path }), ctx())
    expect(r).toMatchObject({ allowed: false, denialReason: 'path_escapes_repo' })
    expect(reads.length).toBe(before)
  })

  it('the model cannot choose the commit', async () => {
    const r = await executeTool(call('read_file', { path: 'src/a.ts', ref: 'main' }), ctx())
    expect(r).toMatchObject({ allowed: false, denialReason: 'invalid_arguments' })
  })

  it.each([[null], ['src/a.ts'], [{}], [{ path: 123 }], [{ path: '' }], [{ path: 'x'.repeat(2000) }]])('denies malformed input %j', async (input) => {
    const r = await executeTool(call('read_file', input), ctx())
    expect(r).toMatchObject({ allowed: false, denialReason: 'invalid_arguments' })
  })

  it('list_changed_files takes no arguments', async () => {
    expect(await executeTool(call('list_changed_files', { path: 'x' }), ctx())).toMatchObject({ allowed: false, denialReason: 'invalid_arguments' })
  })

  it('enforces a call budget', async () => {
    const r = await executeTool(call('read_file', { path: 'src/a.ts' }), ctx({ callsSoFar: 8 }))
    expect(r).toMatchObject({ allowed: false, denialReason: 'budget_exceeded' })
  })

  it('caps how much of a file comes back', async () => {
    const r = await executeTool(call('read_file', { path: 'big.ts' }), ctx({ readFile: async () => 'x'.repeat(100_000) }))
    expect(r.result.length).toBe(32_000)
  })

  it('tells the model nothing about a denied file', async () => {
    const r = await executeTool(call('read_file', { path: '.env' }), ctx({ readFile: async () => 'APP_PRIVATE_KEY=secret' }))
    expect(r.result).not.toContain('secret=')
    expect(r.result).not.toContain('APP_PRIVATE_KEY')
  })
})
