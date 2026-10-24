/** Joins a directory and a child name: ("/", "a") → "/a", ("/a", "b") → "/a/b". */
export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** "/home/alice" → [{ name: "/", path: "/" }, { name: "home", path: "/home" }, { name: "alice", path: "/home/alice" }] */
export function crumbs(path: string): Array<{ name: string; path: string }> {
  const result = [{ name: '/', path: '/' }]
  if (path === '/') return result
  let current = ''
  for (const segment of path.slice(1).split('/')) {
    current += `/${segment}`
    result.push({ name: segment, path: current })
  }
  return result
}

/** The user whose home directory contains `path`, if any: "/home/alice/x" → "alice". */
export function homeOwner(path: string): string | null {
  const match = path.match(/^\/home\/([^/]+)/)
  return match ? match[1] : null
}

/** "/a/b" → "/a"; a top-level path's parent is "/". */
export function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}
