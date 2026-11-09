/**
 * MinIO (S3-compatible) object storage for artifacts and archived logs. Every
 * call has a timeout: a half-dead endpoint must fail the request, not hang it
 * while the job's heartbeat keeps its lease alive.
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

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`blob store ${what} timed out after ${config.minio.timeoutMs} ms`), { code: 'ETIMEDOUT' })), config.minio.timeoutMs)
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

export async function deleteBlob(key: string): Promise<void> {
  await withTimeout(ensureBucket(), 'bucket check')
  await withTimeout(minio.removeObject(bucket, key), 'delete')
}

export function logArchiveKey(repoId: string, runId: string, jobId: string, attempt: number): string {
  return `logs/${repoId}/${runId}/${jobId}/attempt-${attempt}.ndjson`
}

export function artifactKey(repoId: string, runId: string, jobId: string, attempt: number, name: string): string {
  return `artifacts/${repoId}/${runId}/${jobId}/attempt-${attempt}/${name}`
}
