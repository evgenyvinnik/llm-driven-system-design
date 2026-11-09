/**
 * Path normalization and glob matching for the gate and the tool allowlist.
 *
 * A protected-path check is only as good as what it compares. Hosts, checkouts
 * and filesystems disagree about case, separators and dot segments, so every
 * path is reduced to one canonical form before any comparison:
 * percent-decoded, backslashes unified, Unicode NFKC, invisible and control
 * characters removed, dot segments resolved, trailing dots and spaces trimmed
 * from each segment, case folded. A path that climbs out of the repository root
 * is reported, never silently clamped.
 * @module shared/gate/paths
 */

export interface NormalizedPath {
  /** Canonical form, or the best effort when `escapesRoot` is set. */
  path: string
  escapesRoot: boolean
  absolute: boolean
  /** The raw string contained a NUL or other control character. */
  hadControlChars: boolean
}

// Zero-width and bidi controls survive NFKC and render as nothing.
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g
const CONTROL = /[\u0000-\u001f\u007f]/g

function percentDecode(input: string): string {
  let current = input
  // Bounded: double and triple encoding are the only realistic evasions.
  for (let i = 0; i < 3; i++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      break
    }
    if (decoded === current) break
    current = decoded
  }
  return current
}

export function normalizePath(raw: string): NormalizedPath {
  const hadControlChars = /[\u0000-\u001f\u007f]/.test(raw) || /%0[0-9a-f]/i.test(raw) || /%1[0-9a-f]/i.test(raw)
  const cleaned = percentDecode(raw)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .replace(/\\/g, '/')
  const absolute = cleaned.startsWith('/') || /^[a-zA-Z]:\//.test(cleaned)
  const parts: string[] = []
  let escapesRoot = false
  for (const segment of cleaned.split('/')) {
    // Windows strips trailing dots and spaces, so "auth." and "auth " are "auth".
    const s = segment === '.' || segment === '..' ? segment : segment.replace(/[. ]+$/, '')
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (parts.length === 0) escapesRoot = true
      else parts.pop()
      continue
    }
    parts.push(s)
  }
  return { path: parts.join('/').toLowerCase(), escapesRoot, absolute, hadControlChars }
}

/**
 * Glob matching on normalized paths. `**` spans directories, `*` and `?` stay
 * inside one segment, and a pattern ending in `/` means everything below it.
 * Patterns are normalized the same way as paths.
 */
function globToRegex(pattern: string): RegExp {
  const trailingSlash = pattern.endsWith('/')
  const clean = normalizePath(pattern.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\?/g, '')).path
  let re = ''
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (c === '') {
      // "**/" also matches zero directories.
      if (clean[i + 1] === '/') {
        re += '(?:.*/)?'
        i++
      } else {
        re += '.*'
      }
    } else if (c === '') re += '[^/]*'
    else if (c === '') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}${trailingSlash ? '/.*' : ''}$`)
}

export function matchesGlob(normalized: string, pattern: string): boolean {
  // A bare directory pattern also protects what is inside it.
  return globToRegex(pattern).test(normalized) || (!/[*?]/.test(pattern) && globToRegex(`${pattern.replace(/\/$/, '')}/`).test(normalized))
}

export function matchesAny(normalized: string, patterns: string[]): string | null {
  for (const p of patterns) if (matchesGlob(normalized, p)) return p
  return null
}

export interface FilePathEntry {
  path: string
  previousPath: string | null
}

/** Every path a change touches, rename sources included. */
export function touchedPaths(files: FilePathEntry[]): NormalizedPath[] {
  const out: NormalizedPath[] = []
  for (const f of files) {
    out.push(normalizePath(f.path))
    if (f.previousPath) out.push(normalizePath(f.previousPath))
  }
  return out
}
