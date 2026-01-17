import * as Minio from 'minio';

export const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123'
});

const DOCUMENTS_BUCKET = 'docusign-documents';
const SIGNATURES_BUCKET = 'docusign-signatures';

export async function initializeMinio() {
  // Create buckets if they don't exist
  const docsBucketExists = await minioClient.bucketExists(DOCUMENTS_BUCKET);
  if (!docsBucketExists) {
    await minioClient.makeBucket(DOCUMENTS_BUCKET, 'us-east-1');
    console.log(`Created bucket: ${DOCUMENTS_BUCKET}`);
  }

  const sigsBucketExists = await minioClient.bucketExists(SIGNATURES_BUCKET);
  if (!sigsBucketExists) {
    await minioClient.makeBucket(SIGNATURES_BUCKET, 'us-east-1');
    console.log(`Created bucket: ${SIGNATURES_BUCKET}`);
  }
}

export async function uploadDocument(key, buffer, contentType) {
  await minioClient.putObject(DOCUMENTS_BUCKET, key, buffer, buffer.length, {
    'Content-Type': contentType
  });
  return key;
}

export async function getDocument(key) {
  return await minioClient.getObject(DOCUMENTS_BUCKET, key);
}

export async function getDocumentBuffer(key) {
  const stream = await minioClient.getObject(DOCUMENTS_BUCKET, key);
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function getDocumentUrl(key, expiresInSeconds = 3600) {
  return await minioClient.presignedGetObject(DOCUMENTS_BUCKET, key, expiresInSeconds);
}

export async function uploadSignature(key, buffer, contentType) {
  await minioClient.putObject(SIGNATURES_BUCKET, key, buffer, buffer.length, {
    'Content-Type': contentType
  });
  return key;
}

export async function getSignature(key) {
  return await minioClient.getObject(SIGNATURES_BUCKET, key);
}

export async function getSignatureBuffer(key) {
  const stream = await minioClient.getObject(SIGNATURES_BUCKET, key);
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function getSignatureUrl(key, expiresInSeconds = 3600) {
  return await minioClient.presignedGetObject(SIGNATURES_BUCKET, key, expiresInSeconds);
}

export async function deleteDocument(key) {
  await minioClient.removeObject(DOCUMENTS_BUCKET, key);
}

export async function deleteSignature(key) {
  await minioClient.removeObject(SIGNATURES_BUCKET, key);
}
