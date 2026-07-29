/**
 * Seeds the demo database and the media objects that go with it.
 *
 * The SQL half (`db-seed/base.sql`) is the catalog fixture. The second half
 * exists because `/api/stream/:id/play` presigns a MinIO key of the form
 * `videos/{contentId}/{quality}/video.mp4` and 302s the browser to it — with no
 * object behind that key the endpoint falls through to its JSON explanation and
 * the player renders a black rectangle. Uploading one small clip per title is
 * what makes playback, seeking, and resume-from-position actually exercisable.
 *
 * Run with: npm run db:seed
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { pool } from '../db/index.js';
import { s3Client } from '../services/storage.js';
import { MINIO_CONFIG, STREAMING_CONFIG } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Applies the SQL fixture. Idempotent — every statement is ON CONFLICT DO NOTHING. */
async function applyBaseSeed(): Promise<void> {
  const sqlPath = path.resolve(__dirname, '../../db-seed/base.sql');
  if (!fs.existsSync(sqlPath)) {
    console.warn('base.sql not found, skipping SQL seed');
    return;
  }
  await pool.query(fs.readFileSync(sqlPath, 'utf-8'));
  console.log('Base seed applied (accounts, profiles, catalog, progress, my list).');
}

/**
 * A short CC0 clip stood in for every title.
 *
 * There is no transcoding tier here (see the architecture notes), so the same
 * file backs every rung of the quality ladder. That's honest about what the
 * ladder currently is: a manifest describing renditions that nothing produces.
 */
const SAMPLE_VIDEO_URL =
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm';

let sampleBytes: Buffer | null = null;
async function getSample(): Promise<Buffer | null> {
  if (sampleBytes) return sampleBytes;
  try {
    const res = await fetch(SAMPLE_VIDEO_URL);
    if (!res.ok) {
      console.warn(`  sample video fetch failed (${res.status})`);
      return null;
    }
    sampleBytes = Buffer.from(await res.arrayBuffer());
    return sampleBytes;
  } catch (err) {
    console.warn(`  sample video unavailable: ${(err as Error).message}`);
    return null;
  }
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: MINIO_CONFIG.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function seedMedia(): Promise<void> {
  // Playable content is addressed by video id for movies and by *episode* id for
  // series, matching how `/play` builds its key.
  const { rows: videos } = await pool.query<{ id: string }>(
    "SELECT id FROM videos WHERE type = 'movie'",
  );
  const { rows: episodes } = await pool.query<{ id: string }>('SELECT id FROM episodes');
  const contentIds = [...videos.map((v) => v.id), ...episodes.map((e) => e.id)];

  // Every rung gets the same file. That's wasteful in bytes but it makes the
  // quality selector actually work — picking 1080p swaps the URL, and without an
  // object at that key the player would simply go black.
  const qualities = STREAMING_CONFIG.qualities.map((q) => q.name);

  let uploaded = 0;
  for (const contentId of contentIds) {
    for (const quality of qualities) {
      const key = `videos/${contentId}/${quality}/video.mp4`;
      if (await objectExists(key)) continue;

      const bytes = await getSample();
      if (!bytes) return; // Offline: leave it alone rather than half-seeding.

      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: MINIO_CONFIG.bucket,
            Key: key,
            Body: bytes,
            // The key ends in .mp4 but the bytes are WebM. Browsers dispatch on
            // the Content-Type header, not the extension, so declaring it
            // correctly is what makes the element play.
            ContentType: 'video/webm',
          }),
        );
        uploaded++;
      } catch (err) {
        console.warn(`  skipping ${key}: ${(err as Error).message}`);
      }
    }
  }

  console.log(
    `Uploaded ${uploaded} playable objects to MinIO ` +
      `(${contentIds.length} titles x ${qualities.length} qualities).`,
  );
}

applyBaseSeed()
  .then(seedMedia)
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seeding failed:', err);
    pool.end();
    process.exit(1);
  });
