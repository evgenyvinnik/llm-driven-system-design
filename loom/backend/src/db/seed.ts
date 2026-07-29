/**
 * Seeds the demo database and the object storage that goes with it.
 *
 * The SQL half (`db-seed/base.sql`) is the usual users/videos/comments/shares
 * fixture. The second half exists because `videos.thumbnail_path` holds a MinIO
 * *object key*, not a URL — the API presigns it before handing it to the client.
 * A row pointing at `thumbnails/<id>.jpg` with no such object in the bucket
 * yields a presigned URL that 404s, which is why every card in the library
 * rendered a blank placeholder. So this seeder fetches real stills and PUTs
 * them at exactly the keys base.sql references.
 *
 * Run with: npm run db:seed
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../services/db.js';
import { minioClient, ensureBucket } from '../services/storageService.js';
import { config } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Applies the SQL fixture. Idempotent — every statement is ON CONFLICT DO NOTHING. */
async function applyBaseSeed(): Promise<void> {
  const sqlPath = path.resolve(__dirname, '../../db-seed/base.sql');
  if (!fs.existsSync(sqlPath)) {
    console.warn('base.sql not found, skipping SQL seed');
    return;
  }
  await pool.query(fs.readFileSync(sqlPath, 'utf-8'));
  console.log('Base seed applied (users, videos, comments, folders, shares, views).');
}

/**
 * A still that plausibly matches each recording's subject. Keyed by video id so
 * the mapping to base.sql is explicit rather than positional.
 */
const THUMBNAILS: Record<string, string> = {
  // Checkout flow walkthrough
  '11111111-aaaa-4aaa-8aaa-111111111111':
    'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=960&h=540&fit=crop',
  // Sprint 24 standup
  '22222222-aaaa-4aaa-8aaa-222222222222':
    'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=960&h=540&fit=crop',
  // Design review: dashboard v2
  '33333333-aaaa-4aaa-8aaa-333333333333':
    'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=960&h=540&fit=crop',
  // Onboarding for new engineers
  '44444444-aaaa-4aaa-8aaa-444444444444':
    'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=960&h=540&fit=crop',
  // Repro: cart total off by one cent
  '77777777-aaaa-4aaa-8aaa-777777777777':
    'https://images.unsplash.com/photo-1517180102446-f3ece451e9d8?w=960&h=540&fit=crop',
  // Customer call highlights
  '88888888-aaaa-4aaa-8aaa-888888888888':
    'https://images.unsplash.com/photo-1590650153855-d9e808231d41?w=960&h=540&fit=crop',
};

/**
 * A short CC0 clip stood in for every seeded recording.
 *
 * Without real bytes behind `storage_path`, the presigned playback URL 404s and
 * the `<video>` element renders an empty black box — WebKit drops the poster
 * frame once the media resource errors, so even a thumbnail doesn't save it.
 * One small file reused across all rows is enough to make playback, scrubbing,
 * and time-anchored comments actually work locally.
 */
const SAMPLE_VIDEO_URL =
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm';

/** Fetches once and caches, since every video row reuses the same clip. */
let sampleVideoBytes: Buffer | null = null;
async function getSampleVideo(): Promise<Buffer | null> {
  if (sampleVideoBytes) return sampleVideoBytes;
  try {
    const res = await fetch(SAMPLE_VIDEO_URL);
    if (!res.ok) {
      console.warn(`  sample video fetch failed (${res.status})`);
      return null;
    }
    sampleVideoBytes = Buffer.from(await res.arrayBuffer());
    return sampleVideoBytes;
  } catch (err) {
    console.warn(`  sample video unavailable: ${(err as Error).message}`);
    return null;
  }
}

async function seedVideoObjects(): Promise<void> {
  const { rows } = await pool.query<{ id: string; storage_path: string }>(
    "SELECT id, storage_path FROM videos WHERE storage_path IS NOT NULL AND status = 'ready'",
  );

  let uploaded = 0;
  for (const row of rows) {
    try {
      await minioClient.statObject(config.minio.bucket, row.storage_path);
      continue; // Already present.
    } catch {
      // Not present — upload below.
    }

    const bytes = await getSampleVideo();
    if (!bytes) return; // Offline: leave the rows alone rather than half-seeding.

    try {
      await minioClient.putObject(config.minio.bucket, row.storage_path, bytes, bytes.length, {
        'Content-Type': 'video/webm',
      });
      // Keep the reported size honest about what's actually stored.
      await pool.query('UPDATE videos SET file_size_bytes = $1 WHERE id = $2', [
        bytes.length,
        row.id,
      ]);
      uploaded++;
    } catch (err) {
      console.warn(`  skipping ${row.storage_path}: ${(err as Error).message}`);
    }
  }

  console.log(`Uploaded ${uploaded} playable video objects to MinIO.`);
}

async function seedThumbnails(): Promise<void> {
  await ensureBucket();

  const { rows } = await pool.query<{ id: string; thumbnail_path: string }>(
    'SELECT id, thumbnail_path FROM videos WHERE thumbnail_path IS NOT NULL',
  );

  let uploaded = 0;
  for (const row of rows) {
    const url = THUMBNAILS[row.id];
    if (!url) continue;

    // Skip work when the object is already there, so re-seeding is cheap.
    try {
      await minioClient.statObject(config.minio.bucket, row.thumbnail_path);
      continue;
    } catch {
      // Not present — upload it below.
    }

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  fetch failed (${res.status}) for ${url}`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      await minioClient.putObject(config.minio.bucket, row.thumbnail_path, bytes, bytes.length, {
        'Content-Type': 'image/jpeg',
      });
      uploaded++;
    } catch (err) {
      console.warn(`  skipping ${row.thumbnail_path}: ${(err as Error).message}`);
    }
  }

  console.log(`Uploaded ${uploaded} thumbnails to MinIO (${rows.length} videos reference one).`);
}

applyBaseSeed()
  .then(seedThumbnails)
  .then(seedVideoObjects)
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seeding failed:', err);
    pool.end();
    process.exit(1);
  });
