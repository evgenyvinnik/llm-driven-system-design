const Minio = require('minio');
const config = require('../config');

const minioClient = new Minio.Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey
});

// Ensure buckets exist
const initBuckets = async () => {
  const buckets = [config.buckets.videos, config.buckets.thumbnails];

  for (const bucket of buckets) {
    const exists = await minioClient.bucketExists(bucket);
    if (!exists) {
      await minioClient.makeBucket(bucket);
      console.log(`Created bucket: ${bucket}`);
    }
  }
};

module.exports = {
  client: minioClient,
  initBuckets
};
