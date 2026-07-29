/**
 * Seeds a real photo library for the demo user.
 *
 * Photos can't be seeded from SQL alone: the API streams thumbnails/previews out
 * of MinIO by object key, so a row whose `thumbnail_key` is an external URL just
 * produces "Object name contains unsupported characters" and an empty grid. This
 * seeder therefore does what an actual upload does — fetch the image bytes, run
 * sharp to produce the 200x200 thumbnail and 1024x1024 preview, put all three
 * derivatives in MinIO, and only then insert the row.
 *
 * Run with: npm run db:seed:photos
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { pool, minioClient } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies the base SQL seed (users, folders, files) before seeding photos.
 * Kept as one `db:seed` entry point because photos require MinIO objects and
 * therefore cannot live in the .sql file — the harness runs a single seed step.
 */
async function applyBaseSeed(): Promise<void> {
  const sqlPath = path.resolve(__dirname, '../../db-seed/base.sql');
  if (!fs.existsSync(sqlPath)) {
    console.warn('base.sql not found, skipping base seed');
    return;
  }
  await pool.query(fs.readFileSync(sqlPath, 'utf-8'));
  console.log('Base seed applied (users, folders, files).');
}

const PHOTOS_BUCKET = 'icloud-photos';
const THUMBNAILS_BUCKET = 'icloud-thumbnails';

/** Demo user that owns the seeded library (matches db-seed/seed.sql). */
const USER_ID = 'b1ffcc00-0d1c-5f09-cc7e-7cc0ce491b22';

interface SeedPhoto {
  url: string;
  daysAgo: number;
  lat: number;
  lng: number;
  favorite: boolean;
}

const PHOTOS: SeedPhoto[] = [
  { url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1600', daysAgo: 2, lat: 46.5, lng: 8.0, favorite: true },
  { url: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1600', daysAgo: 5, lat: 46.6, lng: 8.1, favorite: false },
  { url: 'https://images.unsplash.com/photo-1439066615861-d1af74d74000?w=1600', daysAgo: 9, lat: 47.0, lng: 8.4, favorite: true },
  { url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1600', daysAgo: 14, lat: 45.9, lng: 7.7, favorite: false },
  { url: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=1600', daysAgo: 21, lat: 46.2, lng: 7.9, favorite: false },
  { url: 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=1600', daysAgo: 30, lat: 46.8, lng: 8.3, favorite: true },
  { url: 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=1600', daysAgo: 45, lat: 47.2, lng: 8.6, favorite: false },
  { url: 'https://images.unsplash.com/photo-1418065460487-3e41a6c84dc5?w=1600', daysAgo: 60, lat: 46.4, lng: 7.5, favorite: false },
  { url: 'https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=1600', daysAgo: 75, lat: 46.1, lng: 8.2, favorite: false },
  { url: 'https://images.unsplash.com/photo-1426604966848-d7adac402bff?w=1600', daysAgo: 90, lat: 45.7, lng: 7.3, favorite: true },
  { url: 'https://images.unsplash.com/photo-1475924156734-496f6cac6ec1?w=1600', daysAgo: 110, lat: 46.9, lng: 8.8, favorite: false },
  { url: 'https://images.unsplash.com/photo-1470252649378-9c29740c9fa8?w=1600', daysAgo: 130, lat: 46.3, lng: 7.8, favorite: false },
];

async function ensureBucket(name: string): Promise<void> {
  if (!(await minioClient.bucketExists(name))) {
    await minioClient.makeBucket(name, 'us-east-1');
  }
}

async function seedPhotos(): Promise<void> {
  // Drop any rows whose keys aren't real MinIO object names (e.g. left over from
  // an earlier SQL-only seed that stored external URLs). Those render as broken
  // tiles because the API streams derivatives from MinIO by key.
  const cleaned = await pool.query(
    "DELETE FROM photos WHERE user_id = $1 AND thumbnail_key LIKE 'http%'",
    [USER_ID]
  );
  if ((cleaned.rowCount ?? 0) > 0) {
    console.log(`Removed ${cleaned.rowCount} photo rows with non-MinIO keys.`);
  }

  const existing = await pool.query('SELECT 1 FROM photos WHERE user_id = $1 LIMIT 1', [USER_ID]);
  if ((existing.rowCount ?? 0) > 0) {
    console.log('Photos already seeded, skipping.');
    return;
  }

  await ensureBucket(PHOTOS_BUCKET);
  await ensureBucket(THUMBNAILS_BUCKET);

  let seeded = 0;
  for (const p of PHOTOS) {
    try {
      const res = await fetch(p.url);
      if (!res.ok) {
        console.warn(`  fetch failed (${res.status}) for ${p.url}`);
        continue;
      }
      const original = Buffer.from(await res.arrayBuffer());

      // Same derivative sizes the upload route produces.
      const thumbnail = await sharp(original).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
      const preview = await sharp(original).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
      const meta = await sharp(original).metadata();

      const photoId = randomUUID();
      const fullResKey = `full/${USER_ID}/${photoId}`;
      const thumbnailKey = `thumb/${USER_ID}/${photoId}`;
      const previewKey = `preview/${USER_ID}/${photoId}`;

      await minioClient.putObject(PHOTOS_BUCKET, fullResKey, original, original.length, {
        'Content-Type': 'image/jpeg',
      });
      await minioClient.putObject(THUMBNAILS_BUCKET, thumbnailKey, thumbnail, thumbnail.length, {
        'Content-Type': 'image/jpeg',
      });
      await minioClient.putObject(THUMBNAILS_BUCKET, previewKey, preview, preview.length, {
        'Content-Type': 'image/jpeg',
      });

      await pool.query(
        `INSERT INTO photos (id, user_id, original_hash, thumbnail_key, preview_key, full_res_key,
                             width, height, taken_at, location_lat, location_lng,
                             camera_make, camera_model, is_favorite)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - ($9 || ' days')::interval, $10, $11,
                 'Apple', 'iPhone 15 Pro', $12)`,
        [
          photoId, USER_ID, photoId, thumbnailKey, previewKey, fullResKey,
          meta.width ?? 1600, meta.height ?? 1200, p.daysAgo, p.lat, p.lng, p.favorite,
        ]
      );
      seeded++;
    } catch (err) {
      console.warn(`  skipping ${p.url}: ${(err as Error).message}`);
    }
  }

  console.log(`Seeded ${seeded} photos with MinIO derivatives.`);
}

applyBaseSeed()
  .then(seedPhotos)
  .then(() => pool.end())
  .catch((err) => {
    console.error('Photo seeding failed:', err);
    pool.end();
    process.exit(1);
  });
