import { describe, expect, it } from 'vitest'
import { matchesAny, matchesGlob, normalizePath, touchedPaths } from './paths.js'

describe('normalizePath', () => {
  it.each([
    ['src/auth/session.ts', 'src/auth/session.ts'],
    ['SRC/Auth/Session.TS', 'src/auth/session.ts'],
    ['./src/auth/session.ts', 'src/auth/session.ts'],
    ['src//auth///session.ts', 'src/auth/session.ts'],
    ['src/./auth/session.ts', 'src/auth/session.ts'],
    ['src/lib/../auth/session.ts', 'src/auth/session.ts'],
    ['src\\auth\\session.ts', 'src/auth/session.ts'],
    ['src%2Fauth%2Fsession.ts', 'src/auth/session.ts'],
    ['src%252Fauth%252Fsession.ts', 'src/auth/session.ts'],
    ['src/auth\u200b/session.ts', 'src/auth/session.ts'],
    ['src/ａｕｔｈ/session.ts', 'src/auth/session.ts'],
    ['src/auth./session.ts', 'src/auth/session.ts'],
    ['src/auth /session.ts', 'src/auth/session.ts'],
  ])('reduces %j to one canonical form', (raw, expected) => {
    expect(normalizePath(raw).path).toBe(expected)
    expect(normalizePath(raw).escapesRoot).toBe(false)
  })

  it.each(['../secrets.txt', 'src/../../secrets.txt', '%2e%2e/secrets.txt', '..\\secrets.txt'])('reports %j as escaping the root', (raw) => {
    expect(normalizePath(raw).escapesRoot).toBe(true)
  })

  it.each(['/etc/passwd', 'C:/Windows/system.ini', '\\etc\\passwd'])('reports %j as absolute', (raw) => {
    expect(normalizePath(raw).absolute).toBe(true)
  })

  it('flags control characters, including encoded ones', () => {
    expect(normalizePath('src/a\u0000b').hadControlChars).toBe(true)
    expect(normalizePath('src/a%00b').hadControlChars).toBe(true)
    expect(normalizePath('src/ab').hadControlChars).toBe(false)
  })

  it('keeps dotfiles', () => {
    expect(normalizePath('.github/workflows/ci.yml').path).toBe('.github/workflows/ci.yml')
    expect(normalizePath('.env').path).toBe('.env')
  })
})

describe('matchesGlob', () => {
  it.each([
    ['src/auth/session.ts', 'src/auth/**', true],
    ['src/auth/deep/er/x.ts', 'src/auth/**', true],
    ['src/authz/x.ts', 'src/auth/**', false],
    ['src/auth/x.ts', 'src/auth', true],
    ['src/auth/x.ts', 'src/auth/', true],
    ['src/authz/x.ts', 'src/auth/', false],
    ['a/b/c.md', '**/*.md', true],
    ['c.md', '**/*.md', true],
    ['c.mdx', '**/*.md', false],
    ['codeowners', 'CODEOWNERS', true],
    ['.github/workflows/ci.yml', '.github/workflows/**', true],
    ['src/x.test.ts', '**/*.test.*', true],
    ['docs/a.txt', 'docs/**/*.txt', true],
    ['requirements.txt', 'docs/**/*.txt', false],
    ['a.ts', '?.ts', true],
    ['ab.ts', '?.ts', false],
    ['src/a/b.ts', 'src/*.ts', false],
  ])('%s vs %s is %s', (path, glob, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected)
  })

  it('returns the pattern that matched', () => {
    expect(matchesAny('src/auth/x.ts', ['docs/**', 'src/auth/**'])).toBe('src/auth/**')
    expect(matchesAny('src/lib/x.ts', ['docs/**', 'src/auth/**'])).toBeNull()
  })
})

describe('touchedPaths', () => {
  it('includes rename sources and targets', () => {
    const paths = touchedPaths([{ path: 'docs/notes.md', previousPath: 'src/auth/notes.md' }, { path: 'README.md', previousPath: null }])
    expect(paths.map((p) => p.path)).toEqual(['docs/notes.md', 'src/auth/notes.md', 'readme.md'])
  })
})
