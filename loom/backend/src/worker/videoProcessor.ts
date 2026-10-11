import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pool } from '../services/db.js';
import { config } from '../config/index.js';
import { markJobDone, type Job } from '../services/jobQueue.js';
import { downloadToFile, uploadFromFile } from '../services/storageService.js';

const run = promisify(execFile);
const TOOL_TIMEOUT_MS = 10 * 60 * 1000;

/** The media operations the processor needs; ffmpeg in production, fakes in tests. */
export interface MediaTools {
  /** Rewrites the container without re-encoding, adding the duration and seek index (cues). */
  remux(input: string, output: string): Promise<void>;
  probeDurationSeconds(file: string): Promise<number | null>;
  hasVideoStream(file: string): Promise<boolean>;
  extractThumbnail(input: string, output: string, atSeconds: number): Promise<void>;
}

export const ffmpegTools: MediaTools = {
  async remux(input, output) {
    await run(
      config.worker.ffmpegPath,
      ['-v', 'error', '-nostdin', '-y', '-i', input, '-map', '0', '-c', 'copy', '-f', 'webm', output],
      { timeout: TOOL_TIMEOUT_MS },
    );
  },
  async probeDurationSeconds(file) {
    const { stdout } = await run(
      config.worker.ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { timeout: TOOL_TIMEOUT_MS },
    );
    const seconds = parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : null;
  },
  async hasVideoStream(file) {
    const { stdout } = await run(
      config.worker.ffprobePath,
      ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
      { timeout: TOOL_TIMEOUT_MS },
    );
    return stdout.trim().length > 0;
  },
  async extractThumbnail(input, output, atSeconds) {
    await run(
      config.worker.ffmpegPath,
      [
        '-v', 'error', '-nostdin', '-y', '-ss', atSeconds.toFixed(2), '-i', input,
        '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', output,
      ],
      { timeout: TOOL_TIMEOUT_MS },
    );
  },
};

export interface ProcessorDeps {
  tools: MediaTools;
  download: (objectName: string, filePath: string) => Promise<void>;
  upload: (objectName: string, filePath: string, contentType: string) => Promise<void>;
  fileSize: (filePath: string) => Promise<number>;
}

const defaultDeps: ProcessorDeps = {
  tools: ffmpegTools,
  download: downloadToFile,
  upload: uploadFromFile,
  fileSize: async (filePath) => (await stat(filePath)).size,
};

/** Output keys sit next to the source and are fixed, so a retried job overwrites, never duplicates. */
export function renditionKeys(sourcePath: string): { playback: string; thumbnail: string } {
  const prefix = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
  const base = prefix ? `${prefix}/` : '';
  return { playback: `${base}playback.webm`, thumbnail: `${base}thumb.jpg` };
}

/**
 * Processes one uploaded recording. MediaRecorder writes WebM without a duration or a
 * seek index, so browsers can't seek it until it has fully downloaded, which breaks
 * jumping to time-anchored comments. A copy-only remux fixes that in seconds; the
 * same pass probes the real duration and grabs a poster frame.
 *
 * The source stays playable the whole time (status 'processing'); this only upgrades it.
 * Results commit in one transaction that first re-checks the lease, so a worker that
 * lost its job can't overwrite the newer owner's work.
 */
export async function processUploadJob(
  job: Job,
  workerId: string,
  deps: ProcessorDeps = defaultDeps,
): Promise<'done' | 'skipped' | 'lost'> {
  const { rows } = await pool.query(
    'SELECT id, status, source_path FROM videos WHERE id = $1',
    [job.video_id],
  );
  const video = rows[0];
  if (!video || video.status !== 'processing' || !video.source_path) {
    // Deleted or already handled; close the job (still fenced) and move on.
    return (await markJobDone(pool, job, workerId)) ? 'skipped' : 'lost';
  }

  const dir = await mkdtemp(join(tmpdir(), `loom-job-${job.id}-`));
  try {
    const input = join(dir, 'source.webm');
    const output = join(dir, 'playback.webm');
    const thumb = join(dir, 'thumb.jpg');
    const keys = renditionKeys(video.source_path);

    await deps.download(video.source_path, input);
    await deps.tools.remux(input, output);
    const duration = await deps.tools.probeDurationSeconds(output);

    let thumbnailKey: string | null = null;
    if (await deps.tools.hasVideoStream(output)) {
      const at = duration ? Math.min(1, duration / 2) : 0;
      await deps.tools.extractThumbnail(output, thumb, at);
      await deps.upload(keys.thumbnail, thumb, 'image/jpeg');
      thumbnailKey = keys.thumbnail;
    }
    await deps.upload(keys.playback, output, 'video/webm');
    const size = await deps.fileSize(output);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!(await markJobDone(client, job, workerId))) {
        await client.query('ROLLBACK');
        return 'lost';
      }
      await client.query(
        `UPDATE videos
         SET status = 'ready', storage_path = $2, thumbnail_path = COALESCE($3, thumbnail_path),
             duration_seconds = COALESCE($4, duration_seconds), file_size_bytes = $5,
             failure_reason = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'processing'`,
        [video.id, keys.playback, thumbnailKey, duration === null ? null : Math.round(duration), size],
      );
      await client.query('COMMIT');
      return 'done';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * When processing has failed for good, the original upload is still a perfectly
 * watchable video. Serve it as-is rather than stranding the video in 'processing'.
 */
export async function giveUpProcessing(videoId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE videos SET status = 'ready', failure_reason = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'processing'`,
    [videoId, `Processing failed, serving the original: ${reason}`.slice(0, 500)],
  );
}
