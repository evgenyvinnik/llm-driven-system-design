/**
 * A fresh directory per job attempt, deleted afterwards. Paths from a workflow or a
 * commit tree are confined to it: `..`, absolute paths and symlinks don't get out.
 * @module runner/workspace
 */
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface AttemptDirs {
  root: string
  workspace: string
  artifacts: string
  scripts: string
}

export async function createAttemptDirs(base: string, label: string): Promise<AttemptDirs> {
  await mkdir(base, { recursive: true })
  const root = await realpath(await mkdtemp(join(base, `${label.replace(/[^A-Za-z0-9_-]/g, '_')}-`)))
  const dirs = { root, workspace: join(root, 'workspace'), artifacts: join(root, 'artifacts'), scripts: join(root, 'scripts') }
  await Promise.all([mkdir(join(dirs.workspace, '.tmp'), { recursive: true }), mkdir(dirs.artifacts), mkdir(dirs.scripts)])
  return dirs
}

export async function removeAttemptDirs(dirs: AttemptDirs): Promise<void> {
  await rm(dirs.root, { recursive: true, force: true })
}

/** The absolute path of `relativePath` inside `root`, or null if it would land outside. */
export function confined(root: string, relativePath: string): string | null {
  if (isAbsolute(relativePath)) return null
  const full = resolve(root, relativePath)
  const rel = relative(root, full)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return full
}

/** The same check after following symlinks: for a file a step created, which might be a link to /etc/passwd. */
export async function confinedReal(root: string, relativePath: string): Promise<string | null> {
  const full = confined(root, relativePath)
  if (!full) return null
  const real = await realpath(full).catch(() => null)
  if (!real) return null
  return confined(root, relative(root, real)) === null ? null : real
}

export async function writeTree(workspace: string, tree: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(tree)) {
    const full = confined(workspace, path)
    if (!full) throw new Error(`Refusing to check out a path outside the workspace: ${path}`)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
    if (path.endsWith('.sh')) await chmod(full, 0o755)
  }
}
