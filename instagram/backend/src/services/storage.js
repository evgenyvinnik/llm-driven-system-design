import * as Minio from 'minio';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';

const minioClient = new Minio.Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

const BUCKET_NAME = config.minio.bucket;

// Ensure bucket exists
export const ensureBucket = async () => {
  try {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME);
      console.log(`Bucket ${BUCKET_NAME} created`);
    }
  } catch (error) {
    console.error('Error ensuring bucket exists:', error);
  }
};

// Image sizes for processing
const IMAGE_SIZES = {
  original: null,
  large: { width: 1080, height: 1080 },
  medium: { width: 640, height: 640 },
  small: { width: 320, height: 320 },
  thumbnail: { width: 150, height: 150 },
};

// CSS filters mapping (simplified for browser-side application)
export const FILTERS = {
  none: '',
  clarendon: 'contrast(1.2) saturate(1.35)',
  gingham: 'brightness(1.05) sepia(0.05)',
  moon: 'grayscale(1) brightness(1.1)',
  lark: 'brightness(1.1) saturate(0.9)',
  reyes: 'sepia(0.22) brightness(1.1) contrast(0.85) saturate(0.75)',
  juno: 'saturate(1.4) contrast(1.1)',
  slumber: 'saturate(0.66) brightness(1.05)',
  crema: 'sepia(0.2) saturate(0.8)',
  ludwig: 'brightness(1.05) saturation(0.9)',
  aden: 'sepia(0.2) brightness(1.15) saturate(1.4)',
  perpetua: 'contrast(1.1) brightness(1.25)',
};

// Upload processed image to MinIO
const uploadBuffer = async (buffer, key, contentType) => {
  await minioClient.putObject(BUCKET_NAME, key, buffer, {
    'Content-Type': contentType,
  });
  return getPublicUrl(key);
};

// Get public URL for object
export const getPublicUrl = (key) => {
  const protocol = config.minio.useSSL ? 'https' : 'http';
  return `${protocol}://${config.minio.endPoint}:${config.minio.port}/${BUCKET_NAME}/${key}`;
};

// Process and upload image
export const processAndUploadImage = async (fileBuffer, originalName, filterName = 'none') => {
  const fileId = uuidv4();
  const ext = 'jpg';
  const results = {};

  // Process image at different sizes
  for (const [sizeName, dimensions] of Object.entries(IMAGE_SIZES)) {
    let processed = sharp(fileBuffer).jpeg({ quality: 85 });

    if (dimensions) {
      processed = processed.resize(dimensions.width, dimensions.height, {
        fit: 'cover',
        position: 'center',
      });
    }

    const buffer = await processed.toBuffer();
    const key = `images/${fileId}/${sizeName}.${ext}`;
    results[sizeName] = await uploadBuffer(buffer, key, 'image/jpeg');
  }

  // Get image dimensions
  const metadata = await sharp(fileBuffer).metadata();

  return {
    id: fileId,
    urls: results,
    width: metadata.width,
    height: metadata.height,
    filter: filterName,
    mediaUrl: results.large,
    thumbnailUrl: results.thumbnail,
  };
};

// Upload video (basic - no transcoding in this implementation)
export const uploadVideo = async (fileBuffer, originalName) => {
  const fileId = uuidv4();
  const ext = originalName.split('.').pop() || 'mp4';
  const key = `videos/${fileId}/original.${ext}`;

  await minioClient.putObject(BUCKET_NAME, key, fileBuffer, {
    'Content-Type': `video/${ext}`,
  });

  return {
    id: fileId,
    mediaUrl: getPublicUrl(key),
    thumbnailUrl: null, // Would need video processing for thumbnail
  };
};

// Upload profile picture
export const uploadProfilePicture = async (fileBuffer) => {
  const fileId = uuidv4();

  // Resize to 150x150 for profile
  const buffer = await sharp(fileBuffer)
    .resize(150, 150, { fit: 'cover', position: 'center' })
    .jpeg({ quality: 90 })
    .toBuffer();

  const key = `profiles/${fileId}.jpg`;
  const url = await uploadBuffer(buffer, key, 'image/jpeg');

  return url;
};

// Delete object
export const deleteObject = async (key) => {
  try {
    await minioClient.removeObject(BUCKET_NAME, key);
  } catch (error) {
    console.error('Error deleting object:', error);
  }
};

// Store original image for async processing
export const storeOriginalImage = async (fileBuffer, originalName) => {
  const fileId = uuidv4();
  const ext = originalName.split('.').pop() || 'jpg';
  const key = `originals/${fileId}.${ext}`;

  await minioClient.putObject(BUCKET_NAME, key, fileBuffer, {
    'Content-Type': 'image/jpeg',
  });

  return { key, fileId };
};

// Fetch original image from MinIO (for worker)
export const fetchOriginalImage = async (key) => {
  const stream = await minioClient.getObject(BUCKET_NAME, key);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

// Process image from stored original (for worker)
export const processStoredImage = async (originalKey, filterName = 'none') => {
  const fileBuffer = await fetchOriginalImage(originalKey);
  return processAndUploadImage(fileBuffer, originalKey, filterName);
};

export default minioClient;
