import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || 'minio_admin',
    secretAccessKey: process.env.MINIO_SECRET_KEY || 'minio_secret'
  },
  forcePathStyle: true
});

export const BUCKETS = {
  AUDIO: 'audio-files',
  ARTWORK: 'album-artwork'
};

export async function uploadFile(bucket, key, body, contentType) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  });

  return s3Client.send(command);
}

export async function getSignedDownloadUrl(bucket, key, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

export async function getPublicUrl(bucket, key) {
  const endpoint = process.env.MINIO_ENDPOINT || 'http://localhost:9000';
  return `${endpoint}/${bucket}/${key}`;
}

export { s3Client };
