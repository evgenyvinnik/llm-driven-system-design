/**
 * Deterministic change classification for the auto-approve scope.
 *
 * A path check alone is not enough, because docs and tests are not inert. Test
 * code runs in CI with CI's secrets, a skipped test weakens the safety net,
 * and a docs page can tell people to pipe a stranger's script into a shell.
 * So a change only counts as `docs` or `tests` if every path matches AND the
 * added content passes an inertness check. Anything else is `other`, which
 * is never in scope. These heuristics can be evaded; escaping them only ever
 * sends the change to a person, and the residual is stated in design-review.md.
 * @module shared/gate/category
 */
import { matchesAny, normalizePath } from './paths.js'
import type { ChangeCategory, GateFile } from './types.js'

// Extensions, not a docs/ prefix: docs/setup.sh is a script. Bare *.txt is excluded because requirements.txt is a dependency list.
export const DOCS_GLOBS = ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', 'docs/**/*.txt', 'license', 'changelog']
export const TEST_GLOBS = ['tests/**', 'test/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*']

export interface Patch {
  added: string[]
  removed: string[]
}

export function parsePatch(patch: string | null): Patch {
  const added: string[] = []
  const removed: string[] = []
  for (const line of (patch ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added.push(line.slice(1))
    else if (line.startsWith('-')) removed.push(line.slice(1))
  }
  return { added, removed }
}

const PIPE_TO_SHELL = /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(python\d?|node|perl|ruby)\b/i
const SCRIPT_TAG = /<\s*(script|iframe|object|embed)\b/i
const DATA_URI = /\bdata:[a-z]+\/[a-z0-9.+-]+;base64,/i
const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+)/gi

const TEST_ENV_ACCESS = /\bprocess\.env\b|\bDeno\.env\b|\bos\.environ\b/
const TEST_NETWORK = /\bfetch\s*\(|\bhttps?\.(get|request)\s*\(|\baxios\b|\bXMLHttpRequest\b|\bnet\.connect\b|\bdns\.(lookup|resolve)\b/
const TEST_PROCESS = /\bchild_process\b|\bexecSync\b|\bspawn(Sync)?\s*\(|\beval\s*\(|\bnew Function\s*\(/
const TEST_WEAKENED = /\b(it|test|describe)\.(skip|only|todo)\b|\bx(it|describe)\s*\(|@ts-ignore|eslint-disable/
const TEST_CASE = /^\s*(it|test)\s*\(/
const ASSERTION = /\b(expect|assert)\b/

function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase()
  return allowlist.some((a) => h === a.toLowerCase() || h.endsWith(`.${a.toLowerCase()}`))
}

export function docsContentProblems(file: GateFile, linkAllowlist: string[]): string[] {
  const problems: string[] = []
  for (const line of parsePatch(file.patch).added) {
    if (PIPE_TO_SHELL.test(line)) problems.push(`${file.path}: adds a pipe from a download into an interpreter`)
    if (SCRIPT_TAG.test(line)) problems.push(`${file.path}: adds active HTML`)
    if (DATA_URI.test(line)) problems.push(`${file.path}: adds a data URI`)
    for (const m of line.matchAll(URL_RE)) {
      if (!hostAllowed(m[1], linkAllowlist)) problems.push(`${file.path}: adds a link to ${m[1].toLowerCase()}, which is not on the allowlist`)
    }
  }
  return problems
}

export function testContentProblems(file: GateFile): string[] {
  const problems: string[] = []
  const { added, removed } = parsePatch(file.patch)
  if (file.status === 'removed') problems.push(`${file.path}: deletes a test file`)
  for (const line of added) {
    if (TEST_ENV_ACCESS.test(line)) problems.push(`${file.path}: reads the environment in test code, which runs with CI secrets`)
    if (TEST_NETWORK.test(line)) problems.push(`${file.path}: adds a network call in test code`)
    if (TEST_PROCESS.test(line)) problems.push(`${file.path}: spawns a process or evaluates code in test code`)
    if (TEST_WEAKENED.test(line)) problems.push(`${file.path}: skips or suppresses a test`)
  }
  const removedCases = removed.filter((l) => TEST_CASE.test(l)).length
  const addedCases = added.filter((l) => TEST_CASE.test(l)).length
  if (removedCases > addedCases) problems.push(`${file.path}: removes ${removedCases - addedCases} test case(s)`)
  const removedAsserts = removed.filter((l) => ASSERTION.test(l)).length
  const addedAsserts = added.filter((l) => ASSERTION.test(l)).length
  if (removedAsserts > addedAsserts) problems.push(`${file.path}: removes ${removedAsserts - addedAsserts} assertion(s)`)
  return problems
}

export function classifyChange(files: GateFile[], linkAllowlist: string[]): { category: ChangeCategory; reasons: string[] } {
  if (files.length === 0) return { category: 'other', reasons: ['the change has no files'] }
  let sawDocs = false
  let sawTests = false
  const reasons: string[] = []
  for (const f of files) {
    const candidates = [f.path, ...(f.previousPath ? [f.previousPath] : [])].map((p) => normalizePath(p))
    if (candidates.some((c) => c.escapesRoot || c.absolute)) return { category: 'other', reasons: [`${f.path}: path escapes the repository`] }
    // Test globs win: `tests/README.md` is docs by extension but lives with test code.
    const allTests = candidates.every((c) => matchesAny(c.path, TEST_GLOBS))
    const allDocs = candidates.every((c) => matchesAny(c.path, DOCS_GLOBS))
    if (allDocs && !(allTests && !/\.(md|mdx|rst|txt)$/.test(candidates[0].path))) {
      sawDocs = true
      reasons.push(...docsContentProblems(f, linkAllowlist))
    } else if (allTests) {
      sawTests = true
      reasons.push(...testContentProblems(f))
    } else {
      return { category: 'other', reasons: [`${f.path}: not a docs or test path`] }
    }
  }
  if (reasons.length > 0) return { category: 'other', reasons }
  if (sawDocs && sawTests) return { category: 'docs_and_tests', reasons: [] }
  return { category: sawDocs ? 'docs' : 'tests', reasons: [] }
}
