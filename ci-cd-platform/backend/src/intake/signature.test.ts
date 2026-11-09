import { describe, expect, it } from 'vitest'
import { signBody, verifySignature } from './signature.js'

const body = Buffer.from('{"ref":"refs/heads/main"}')

describe('webhook signature', () => {
  it('accepts its own signature', () => {
    expect(verifySignature('s3cret', body, signBody('s3cret', body))).toBe(true)
  })

  it('rejects the wrong key, a changed body, a missing header and a malformed one', () => {
    const good = signBody('s3cret', body)
    expect(verifySignature('other', body, good)).toBe(false)
    expect(verifySignature('s3cret', Buffer.from(`${body} `), good)).toBe(false)
    expect(verifySignature('s3cret', body, undefined)).toBe(false)
    expect(verifySignature('s3cret', body, 'sha256=abc')).toBe(false)
    expect(verifySignature('s3cret', body, good.replace('sha256=', 'sha1='))).toBe(false)
  })

  it('matches the documented GitHub test vector', () => {
    expect(signBody("It's a Secret to Everybody", 'Hello, World!')).toBe('sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17')
  })
})
