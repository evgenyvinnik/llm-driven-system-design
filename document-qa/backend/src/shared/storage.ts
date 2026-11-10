/**
 * MinIO (S3-compatible) object storage for original uploads. Each document
 * version has its own key, `<org>/<document>/v<n>-<hash prefix>.<ext>`, so a
 * new version never overwrites the bytes an older version's chunks came from.
 * @module shared/storage
 */
import * as Minio from 'minio'
import { config } from './config.js'
import { logger } from './logger.js'

export const minio = new Minio.Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
})

const bucket = config.minio.bucket
const BLOB_TIMEOUT_MS = Number(process.env.BLOB_TIMEOUT_MS ?? 15_000)

/** A blob call that hangs (a half-dead endpoint) must fail the attempt, not hold the job's lease forever. */
function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`blob store ${what} timed out after ${BLOB_TIMEOUT_MS} ms`), { code: 'ETIMEDOUT' })), BLOB_TIMEOUT_MS)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}
let bucketReady: Promise<void> | null = null

export function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const exists = await minio.bucketExists(bucket)
      if (!exists) {
        await minio.makeBucket(bucket).catch((err: Error & { code?: string }) => {
          // Another process created it first.
          if (err.code !== 'BucketAlreadyOwnedByYou' && err.code !== 'BucketAlreadyExists') throw err
        })
        logger.info({ bucket }, 'created bucket')
      }
    })().catch((err) => {
      bucketReady = null
      throw err
    })
  }
  return bucketReady
}

export function blobKey(orgId: string, documentId: string, versionNo: number, contentHash: string, ext: string): string {
  return `${orgId}/${documentId}/v${versionNo}-${contentHash.slice(0, 12)}.${ext || 'bin'}`
}

export async function putBlob(key: string, bytes: Buffer, contentType: string): Promise<void> {
  await withTimeout(ensureBucket(), 'bucket check')
  await withTimeout(minio.putObject(bucket, key, bytes, bytes.length, { 'Content-Type': contentType }), 'put')
}

export async function getBlob(key: string): Promise<Buffer> {
  await withTimeout(ensureBucket(), 'bucket check')
  return withTimeout(
    (async () => {
      const stream = await minio.getObject(bucket, key)
      const parts: Buffer[] = []
      for await (const part of stream) parts.push(part as Buffer)
      return Buffer.concat(parts)
    })(),
    'get',
  )
}

/** Deletes keys; a key that is already gone counts as deleted (purge is idempotent). */
export async function deleteBlobs(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0
  await withTimeout(ensureBucket(), 'bucket check')
  await withTimeout(minio.removeObjects(bucket, keys), 'delete')
  return keys.length
}

export async function blobExists(key: string): Promise<boolean> {
  try {
    await minio.statObject(bucket, key)
    return true
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'NotFound' || code === 'NoSuchKey') return false
    throw err
  }
}
