import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedDemo } from '../db/seed-data.js'
import { MemoryBackend } from '../store/memory-backend.js'
import { createApp } from './app.js'

let app: ReturnType<typeof createApp>

beforeEach(async () => {
  const backend = new MemoryBackend()
  await seedDemo(backend)
  app = createApp(backend)
})

describe('health and info', () => {
  it('reports health, readiness and the store in use', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' })
    expect((await request(app).get('/ready')).body).toEqual({ status: 'ready', store: 'memory' })
    expect((await request(app).get('/api/v1/info')).body).toEqual({ store: 'memory' })
  })
})

describe('GET /api/v1/fs/list', () => {
  it('lists the root with directory totals', async () => {
    const res = await request(app).get('/api/v1/fs/list')
    expect(res.status).toBe(200)
    expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual(['archive', 'home', 'shared', 'system'])
    expect(res.body.fileCount).toBe(25)
    const shared = res.body.entries.find((e: { name: string }) => e.name === 'shared')
    expect(shared).toMatchObject({ kind: 'dir', fileCount: 3, size: 301_442 + 18_230 + 2_202_009 })
  })

  it("shows each file's owner", async () => {
    const res = await request(app).get('/api/v1/fs/list').query({ path: '/shared' })
    expect(res.body.entries).toContainEqual({ name: 'roadmap.md', kind: 'file', size: 18_230, owner: 'bob', fileCount: 1 })
  })

  it('returns 404 for a file and 422 for a malformed path', async () => {
    const file = await request(app).get('/api/v1/fs/list').query({ path: '/home/bob/todo.txt' })
    expect(file.status).toBe(404)
    expect(file.body.error.code).toBe('NOT_A_DIRECTORY')
    expect((await request(app).get('/api/v1/fs/list').query({ path: '/a//b' })).status).toBe(422)
  })
})

describe('file writes', () => {
  it('creates a file for a user and returns the remaining capacity', async () => {
    const res = await request(app).post('/api/v1/fs/files').send({ path: '/home/dmitri/notes.txt', size: 1000, owner: 'dmitri' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ path: '/home/dmitri/notes.txt', size: 1000, owner: 'dmitri', remaining: 8 * 1024 * 1024 - 7_341_232 - 1000 })
  })

  it('creates an unowned file when no owner is given', async () => {
    const res = await request(app).post('/api/v1/fs/files').send({ path: '/system/new.cfg', size: 10 })
    expect(res.body).toMatchObject({ owner: null, remaining: null })
  })

  it.each([
    [{ path: '/home/bob/todo.txt', size: 1 }, 'PATH_EXISTS'],
    [{ path: '/home/bob', size: 1 }, 'PATH_IS_DIRECTORY'],
    [{ path: '/home/bob/todo.txt/x', size: 1 }, 'PARENT_IS_FILE'],
    [{ path: '/home/dmitri/huge.iso', size: 2_000_000, owner: 'dmitri' }, 'OVER_CAPACITY'],
  ])('refuses %o with 409 %s', async (body, code) => {
    const res = await request(app).post('/api/v1/fs/files').send(body)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe(code)
  })

  it('returns 404 for an unknown owner', async () => {
    const res = await request(app).post('/api/v1/fs/files').send({ path: '/x', size: 1, owner: 'ghost' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('USER_NOT_FOUND')
  })

  it('updates a file and reports the previous size, refusing growth past the quota', async () => {
    const ok = await request(app).patch('/api/v1/fs/files').query({ path: '/home/dmitri/readme.txt' }).send({ size: 2_000 })
    expect(ok.body).toEqual({ path: '/home/dmitri/readme.txt', size: 2_000, previous: 1_200 })
    const tooBig = await request(app).patch('/api/v1/fs/files').query({ path: '/home/dmitri/readme.txt' }).send({ size: 5_000_000 })
    expect(tooBig.status).toBe(409)
    expect(tooBig.body.error.code).toBe('OVER_CAPACITY')
  })

  it('deletes a file and returns 404 the second time', async () => {
    const first = await request(app).delete('/api/v1/fs/files').query({ path: '/home/bob/todo.txt' })
    expect(first.body).toEqual({ path: '/home/bob/todo.txt', size: 402 })
    expect((await request(app).delete('/api/v1/fs/files').query({ path: '/home/bob/todo.txt' })).status).toBe(404)
  })

  it('validates sizes and paths', async () => {
    expect((await request(app).post('/api/v1/fs/files').send({ path: 'relative', size: 1 })).status).toBe(422)
    expect((await request(app).post('/api/v1/fs/files').send({ path: '/a/../b', size: 1 })).status).toBe(422)
    expect((await request(app).post('/api/v1/fs/files').send({ path: '/ok', size: -1 })).status).toBe(422)
    expect((await request(app).post('/api/v1/fs/files').send({ path: '/ok', size: 1.5 })).status).toBe(422)
  })
})

describe('GET /api/v1/fs/largest', () => {
  it('returns the biggest files under a prefix, ties broken by path', async () => {
    const res = await request(app).get('/api/v1/fs/largest').query({ prefix: '/home/alice/photos/', n: 3 })
    expect(res.body.files).toEqual([
      { path: '/home/alice/photos/lake.jpg', size: 3_481_220 },
      { path: '/home/alice/photos/trail-copy.jpg', size: 2_877_105 },
      { path: '/home/alice/photos/trail.jpg', size: 2_877_105 },
    ])
  })
})

describe('users', () => {
  it('lists users with usage and backups', async () => {
    const { users } = (await request(app).get('/api/v1/users')).body
    expect(users.map((u: { id: string }) => u.id)).toEqual(['alice', 'bob', 'carol', 'carol-archive', 'dmitri'])
    expect(users.find((u: { id: string }) => u.id === 'alice')).toMatchObject({ fileCount: 8, backup: { fileCount: 8 } })
    expect(users.find((u: { id: string }) => u.id === 'bob')).toMatchObject({ fileCount: 4, backup: null })
  })

  it('creates a user once', async () => {
    expect((await request(app).post('/api/v1/users').send({ id: 'erin', capacity: 1000 })).status).toBe(201)
    expect((await request(app).post('/api/v1/users').send({ id: 'erin', capacity: 1000 })).body.error.code).toBe('USER_EXISTS')
  })

  it('merges a user into another, and refuses a self-merge', async () => {
    const res = await request(app).post('/api/v1/users/carol/merge').send({ sourceId: 'carol-archive' })
    expect(res.status).toBe(200)
    expect(res.body.remaining).toBe(28 * 1024 * 1024 - 13_040_025 - 2_103_252)
    expect((await request(app).post('/api/v1/users/carol/merge').send({ sourceId: 'carol' })).status).toBe(422)
  })

  it('restores alice, reporting the path bob now owns as skipped', async () => {
    const res = await request(app).post('/api/v1/users/alice/restore')
    expect(res.body).toEqual({ id: 'alice', restored: 7, skipped: ['/shared/roadmap.md'] })
    const home = await request(app).get('/api/v1/fs/list').query({ path: '/home/alice' })
    expect(home.body.entries.map((e: { name: string }) => e.name)).toEqual(['notes', 'photos', 'thesis.pdf'])
  })

  it('backs up a user', async () => {
    expect((await request(app).post('/api/v1/users/bob/backup')).body).toEqual({ id: 'bob', fileCount: 4 })
  })
})

describe('admin reset', () => {
  it('puts the demo data back', async () => {
    await request(app).delete('/api/v1/fs/files').query({ path: '/home/bob/todo.txt' })
    await request(app).post('/api/v1/admin/reset')
    const bob = await request(app).get('/api/v1/fs/list').query({ path: '/home/bob' })
    expect(bob.body.entries.map((e: { name: string }) => e.name)).toEqual(['music', 'todo.txt'])
  })
})
