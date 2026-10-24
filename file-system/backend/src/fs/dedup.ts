/**
 * Worked answer to the onsite variant in levels.md: find groups of files with
 * identical contents in a large tree, without reading any file whole into
 * memory and without hashing files that can't have a duplicate.
 *
 * Candidates are narrowed in stages, each costlier than the last:
 * 1. Size, from the directory walk's metadata. A unique size can't be a duplicate.
 * 2. A hash of the first 4 KB. Cheap, and it separates most same-size files that
 *    differ (different headers, different first lines).
 * 3. A streamed SHA-256 of the whole file, only for files still tied. Files no
 *    bigger than 4 KB skip this: their head hash already covered every byte.
 *
 * A SHA-256 match is treated as equal. If a collision mattered (adversarial
 * input), a final byte-by-byte comparison of streams would confirm each group.
 * @module fs/dedup
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const HEAD_BYTES = 4096

export interface DedupStats {
  /** Regular files found by the walk. */
  files: number
  /** Files that shared their size with another file. */
  sizeCandidates: number
  headHashed: number
  fullHashed: number
  /** Bytes actually read from disk, across both hashing stages. */
  bytesRead: number
}

export async function findDuplicates(root: string): Promise<string[][]> {
  return (await scanDuplicates(root)).groups
}

export async function scanDuplicates(root: string): Promise<{ groups: string[][]; stats: DedupStats }> {
  const stats: DedupStats = { files: 0, sizeCandidates: 0, headHashed: 0, fullHashed: 0, bytesRead: 0 }

  const bySize = new Map<number, string[]>()
  for await (const { path, size } of walk(root)) {
    stats.files += 1
    const group = bySize.get(size)
    if (group) group.push(path)
    else bySize.set(size, [path])
  }

  const groups: string[][] = []
  for (const [size, sameSize] of bySize) {
    if (sameSize.length < 2) continue
    stats.sizeCandidates += sameSize.length

    for (const sameHead of await groupBy(sameSize, async (path) => {
      stats.headHashed += 1
      return hashHead(path, stats)
    })) {
      if (sameHead.length < 2) continue
      if (size <= HEAD_BYTES) {
        groups.push(sameHead)
        continue
      }
      for (const sameContent of await groupBy(sameHead, async (path) => {
        stats.fullHashed += 1
        return hashFile(path, stats)
      })) {
        if (sameContent.length >= 2) groups.push(sameContent)
      }
    }
  }

  for (const group of groups) group.sort()
  groups.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return { groups, stats }
}

/**
 * Depth-first walk with an explicit stack, so a deep tree can't overflow the
 * call stack. Symbolic links are skipped, not followed: following them could
 * loop forever and would report one file as its own duplicate.
 */
async function* walk(root: string): AsyncGenerator<{ path: string; size: number }> {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile()) yield { path, size: (await lstat(path)).size }
    }
  }
}

async function groupBy(paths: string[], key: (path: string) => Promise<string>): Promise<string[][]> {
  const groups = new Map<string, string[]>()
  // Sequential on purpose: hashing is disk-bound, and a bounded pool (say 8 at a
  // time) is the next step if one disk's latency, not its bandwidth, is the limit.
  for (const path of paths) {
    const k = await key(path)
    const group = groups.get(k)
    if (group) group.push(path)
    else groups.set(k, [path])
  }
  return [...groups.values()]
}

async function hashHead(path: string, stats: DedupStats): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    stats.bytesRead += bytesRead
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
  } finally {
    await handle.close()
  }
}

function hashFile(path: string, stats: DedupStats): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path, { highWaterMark: 64 * 1024 })
      .on('data', (chunk) => {
        stats.bytesRead += chunk.length
        hash.update(chunk)
      })
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}
