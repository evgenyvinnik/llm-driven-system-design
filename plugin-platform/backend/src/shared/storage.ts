import { Client } from 'minio';

// MinIO configuration
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'localhost';
const MINIO_PORT = parseInt(process.env.MINIO_PORT || '9000', 10);
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';
const PLUGIN_BUCKET = process.env.PLUGIN_BUCKET || 'plugins';

// Create MinIO client
export const minioClient = new Client({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

// Ensure bucket exists
export async function ensureBucket(): Promise<void> {
  try {
    const exists = await minioClient.bucketExists(PLUGIN_BUCKET);
    if (!exists) {
      await minioClient.makeBucket(PLUGIN_BUCKET);
      console.log(`Created bucket: ${PLUGIN_BUCKET}`);
    }
  } catch (err) {
    console.error('Failed to ensure bucket exists:', err);
  }
}

// Upload plugin bundle
export async function uploadPluginBundle(
  pluginId: string,
  version: string,
  buffer: Buffer
): Promise<string> {
  const objectName = `${pluginId}/${version}/bundle.js`;

  await minioClient.putObject(
    PLUGIN_BUCKET,
    objectName,
    buffer,
    buffer.length,
    { 'Content-Type': 'application/javascript' }
  );

  // Return the public URL
  const baseUrl = MINIO_USE_SSL ? 'https' : 'http';
  return `${baseUrl}://${MINIO_ENDPOINT}:${MINIO_PORT}/${PLUGIN_BUCKET}/${objectName}`;
}

// Upload plugin source map (for debugging)
export async function uploadPluginSourceMap(
  pluginId: string,
  version: string,
  buffer: Buffer
): Promise<string> {
  const objectName = `${pluginId}/${version}/bundle.js.map`;

  await minioClient.putObject(
    PLUGIN_BUCKET,
    objectName,
    buffer,
    buffer.length,
    { 'Content-Type': 'application/json' }
  );

  const baseUrl = MINIO_USE_SSL ? 'https' : 'http';
  return `${baseUrl}://${MINIO_ENDPOINT}:${MINIO_PORT}/${PLUGIN_BUCKET}/${objectName}`;
}

// Get plugin bundle URL
export function getPluginBundleUrl(pluginId: string, version: string): string {
  const baseUrl = MINIO_USE_SSL ? 'https' : 'http';
  return `${baseUrl}://${MINIO_ENDPOINT}:${MINIO_PORT}/${PLUGIN_BUCKET}/${pluginId}/${version}/bundle.js`;
}

// Delete plugin version files
export async function deletePluginVersion(pluginId: string, version: string): Promise<void> {
  const objectsToDelete = [
    `${pluginId}/${version}/bundle.js`,
    `${pluginId}/${version}/bundle.js.map`,
  ];

  for (const objectName of objectsToDelete) {
    try {
      await minioClient.removeObject(PLUGIN_BUCKET, objectName);
    } catch {
      // Ignore if object doesn't exist
    }
  }
}

// Delete all plugin files
export async function deletePluginFiles(pluginId: string): Promise<void> {
  const stream = minioClient.listObjects(PLUGIN_BUCKET, `${pluginId}/`, true);
  const objects: string[] = [];

  for await (const obj of stream) {
    if (obj.name) {
      objects.push(obj.name);
    }
  }

  for (const objectName of objects) {
    await minioClient.removeObject(PLUGIN_BUCKET, objectName);
  }
}
