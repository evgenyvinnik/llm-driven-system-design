import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findDuplicates } from '../dedup.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dedup-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(relative: string, contents: string | Buffer) {
  const path = join(root, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  return path
}

describe('onsite variant: findDuplicates', () => {
  it('returns an empty list when nothing repeats', async () => {
    await put('a.txt', 'alpha')
    await put('b.txt', 'beta')
    expect(await findDuplicates(root)).toEqual([])
  })

  it('groups identical files across directories, sorted within and between groups', async () => {
    const a1 = await put('x/a.txt', 'same A')
    const a2 = await put('a.txt', 'same A')
    const b1 = await put('deep/er/b.bin', 'same B!')
    const b2 = await put('z/b.bin', 'same B!')
    const b3 = await put('b-copy', 'same B!')
    await put('unique', 'only one')
    // root/a.txt < root/x/a.txt, and root/a.txt < root/b-copy < root/deep/... < root/z/...
    expect(await findDuplicates(root)).toEqual([
      [a2, a1],
      [b3, b1, b2],
    ])
  })

  it('separates same-size files with different contents', async () => {
    const one = await put('one', 'abcd')
    const two = await put('two', 'abcd')
    await put('three', 'abce')
    expect(await findDuplicates(root)).toEqual([[one, two].sort()])
  })

  it('separates large files that share their first 4 KB but differ later', async () => {
    const head = Buffer.alloc(4096, 7)
    const p = await put('p', Buffer.concat([head, Buffer.from('tail-1')]))
    const q = await put('q', Buffer.concat([head, Buffer.from('tail-1')]))
    await put('r', Buffer.concat([head, Buffer.from('tail-2')]))
    expect(await findDuplicates(root)).toEqual([[p, q].sort()])
  })

  it('treats empty files as duplicates of each other', async () => {
    const e1 = await put('e1', '')
    const e2 = await put('d/e2', '')
    expect(await findDuplicates(root)).toEqual([[e1, e2].sort()])
  })

  it('does not follow symbolic links', async () => {
    const real = await put('real.txt', 'linked contents')
    await symlink(real, join(root, 'link.txt'))
    await symlink(root, join(root, 'loop'))
    expect(await findDuplicates(root)).toEqual([])
  })
})
