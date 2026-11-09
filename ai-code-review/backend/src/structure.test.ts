/**
 * Boundaries that are the design, checked as code rather than left to convention.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(fileURLToPath(import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

const all = sources(root).map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }))
const under = (prefix: string) => all.filter((f) => f.path.startsWith(prefix))

describe('the model cannot reach authority', () => {
  it('the gate reads no model output', () => {
    const rules = all.find((f) => f.path === 'shared/gate/rules.ts')!
    expect(rules.text).not.toMatch(/model-output|ModelOutput|ModelSignal|verdict/)
    for (const f of under('shared/gate/').filter((x) => x.path !== 'shared/gate/decide.ts')) expect(f.text, f.path).not.toMatch(/from '.*model/)
  })
  it('the gate is pure: no database, network or clock', () => {
    for (const f of under('shared/gate/')) {
      expect(f.text, f.path).not.toMatch(/from '.*\/db\.js'|from 'pg'|\bfetch\(|Date\.now\(\)|process\.env/)
    }
  })
})

describe('credentials', () => {
  it('only the poster imports the write client', () => {
    const importers = all.filter((f) => /from '.*host-writer/.test(f.text) && !f.path.startsWith('poster/'))
    expect(importers.map((f) => f.path)).toEqual([])
  })
  it('the worker never imports the poster', () => {
    for (const f of under('worker/')) expect(f.text, f.path).not.toMatch(/from '\.\.\/poster/)
  })
  it('the poster token is read nowhere but the poster and the host', () => {
    const readers = all.filter((f) => f.text.includes('GITHOST_POSTER_TOKEN')).map((f) => f.path)
    expect(readers.sort()).toEqual(['githost/auth.ts', 'poster/host-writer.ts'])
  })
  it('the shared client only offers reads', () => {
    const client = all.find((f) => f.path === 'shared/host-client.ts')!
    expect(client.text).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/)
    expect(client.text).not.toContain('postReview')
  })
})

describe('the host is a separate system', () => {
  it('only the host process and the in-process test harness touch its tables', () => {
    const allowed = new Set(['db/materialize.ts'])
    const offenders = all.filter((f) => /\bgithost\.[a-z_]+/.test(f.text.replace(/\/\*[\s\S]*?\*\//g, '')) && !f.path.startsWith('githost/') && !allowed.has(f.path))
    expect(offenders.map((f) => f.path)).toEqual([])
  })
})

describe('no policy is read from the repository', () => {
  it('neither gate nor pipeline fetches a config file from the tree', () => {
    for (const f of [...under('shared/gate/'), ...under('worker/pipeline')]) expect(f.text, f.path).not.toMatch(/readFile\([^)]*(autoreview|policy|\.yml)/i)
  })
})
