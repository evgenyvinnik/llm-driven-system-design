import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { hashPassword, verifyPassword } from './password.js'

describe('password hashing', () => {
  it('salts each hash and verifies the right password only', async () => {
    const a = await hashPassword('password123')
    const b = await hashPassword('password123')
    expect(a).not.toBe(b)
    expect(a.startsWith('scrypt:')).toBe(true)
    expect(await verifyPassword('password123', a)).toEqual({ ok: true, needsRehash: false })
    expect((await verifyPassword('password124', a)).ok).toBe(false)
  })

  it('accepts a legacy unsalted sha256 digest and asks for a rehash', async () => {
    const legacy = crypto.createHash('sha256').update('password123').digest('hex')
    expect(await verifyPassword('password123', legacy)).toEqual({ ok: true, needsRehash: true })
    expect(await verifyPassword('wrong', legacy)).toEqual({ ok: false, needsRehash: false })
  })
})
