/**
 * MinIO object storage module.
 * Provides S3-compatible storage for drawing stroke data and trained ML models.
 * Separates large binary data from PostgreSQL for better scalability.
 * @module shared/storage
 */

import { Client } from 'minio'

/**
 * MinIO client instance configured from environment or defaults.
 * Used for all object storage operations (upload, download, list).
 */
const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
})

/** Bucket name for storing drawing stroke data as JSON files */
export const DRAWINGS_BUCKET = 'drawings'

/** Bucket name for storing trained PyTorch model files */
export const MODELS_BUCKET = 'models'

/**
 * Ensures required storage buckets exist, creating them if necessary.
 * Called during service startup to guarantee storage infrastructure is ready.
 * @returns Promise that resolves when all buckets are verified/created
 */
export async function ensureBuckets(): Promise<void> {
  for (const bucket of [DRAWINGS_BUCKET, MODELS_BUCKET]) {
    const exists = await minioClient.bucketExists(bucket)
    if (!exists) {
      await minioClient.makeBucket(bucket)
      console.log(`Created bucket: ${bucket}`)
    }
  }
}

/**
 * Uploads drawing stroke data to MinIO as a JSON file.
 * Stores the complete stroke information including points, timing, and canvas metadata.
 * The JSON format preserves all data needed for training and replay.
 *
 * @param drawingId - Unique identifier for the drawing (UUID)
 * @param data - Object containing stroke data to serialize and store
 * @returns Promise resolving to the object name (path) in the bucket
 */
export async function uploadDrawing(
  drawingId: string,
  data: object
): Promise<string> {
  const objectName = `${drawingId}.json`
  const buffer = Buffer.from(JSON.stringify(data))

  await minioClient.putObject(DRAWINGS_BUCKET, objectName, buffer, buffer.length, {
    'Content-Type': 'application/json',
  })

  return objectName
}

/**
 * Downloads and parses drawing stroke data from MinIO.
 * Retrieves the JSON file and deserializes it for rendering or processing.
 *
 * @param objectName - The object name/path returned from uploadDrawing
 * @returns Promise resolving to the parsed stroke data object
 */
export async function getDrawing(objectName: string): Promise<object> {
  const stream = await minioClient.getObject(DRAWINGS_BUCKET, objectName)
  const chunks: Buffer[] = []

  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf-8')
      resolve(JSON.parse(data))
    })
    stream.on('error', reject)
  })
}

/**
 * Uploads a trained PyTorch model file to MinIO.
 * Models are stored as binary .pt files for later loading by the inference service.
 *
 * @param modelId - Unique identifier for the model version
 * @param modelBuffer - Binary buffer containing the serialized PyTorch model
 * @returns Promise resolving to the object name (path) in the bucket
 */
export async function uploadModel(
  modelId: string,
  modelBuffer: Buffer
): Promise<string> {
  const objectName = `${modelId}.pt`

  await minioClient.putObject(MODELS_BUCKET, objectName, modelBuffer, modelBuffer.length, {
    'Content-Type': 'application/octet-stream',
  })

  return objectName
}

/**
 * Downloads a trained model file from MinIO.
 * Returns the raw binary buffer for loading into the inference framework.
 *
 * @param objectName - The object name/path of the model file
 * @returns Promise resolving to a Buffer containing the model data
 */
export async function getModel(objectName: string): Promise<Buffer> {
  const stream = await minioClient.getObject(MODELS_BUCKET, objectName)
  const chunks: Buffer[] = []

  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/**
 * Lists all drawing objects in the bucket, optionally filtered by prefix.
 * Useful for batch operations like training data export.
 *
 * @param prefix - Optional prefix to filter results (e.g., "2024-01/" for January drawings)
 * @returns Promise resolving to array of object names matching the prefix
 */
export async function listDrawings(prefix?: string): Promise<string[]> {
  const objects: string[] = []
  const stream = minioClient.listObjects(DRAWINGS_BUCKET, prefix)

  return new Promise((resolve, reject) => {
    stream.on('data', (obj) => {
      if (obj.name) objects.push(obj.name)
    })
    stream.on('end', () => resolve(objects))
    stream.on('error', reject)
  })
}

export { minioClient }
