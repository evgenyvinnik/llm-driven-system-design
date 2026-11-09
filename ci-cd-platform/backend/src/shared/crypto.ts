/**
 * AES-256-GCM for everything secret at rest: secret values, webhook HMAC keys,
 * held-back partial log lines, masks. The master key comes from
 * CICD_MASTER_KEY; the default is a development key and is documented as such.
 * The associated data binds a ciphertext to where it belongs, so a value copied
 * to another row (another repository, another scope) fails to decrypt.
 * @module shared/crypto
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from './config.js'

const key = createHash('sha256').update(config.masterKey).digest()

export function encrypt(plaintext: string, aad: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
}

export function decrypt(stored: string, aad: string): string {
  const [version, iv, tag, body] = stored.split('.')
  if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('unrecognized ciphertext format')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}
