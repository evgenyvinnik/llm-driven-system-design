import type { Video } from '../types';

/** S3/MinIO reject multipart parts under 5 MiB, except the last one. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;

/** Network operations the uploader needs. The real one talks to the API and storage. */
export interface UploadTransport {
  /** Creates the video row and opens the multipart upload. Must be safe to retry. */
  start(): Promise<{ videoId: string; partSize?: number }>;
  partUrl(videoId: string, partNumber: number): Promise<string>;
  putPart(url: string, body: Blob, onProgress: (loadedBytes: number) => void): Promise<void>;
  complete(videoId: string, partCount: number, durationSeconds: number): Promise<Video>;
}

export interface UploaderOptions {
  partSize?: number;
  /** Parts uploaded at the same time. */
  concurrency?: number;
  /** Tries per network operation before the upload pauses in the 'error' phase. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type UploadPhase = 'recording' | 'finishing' | 'done' | 'error' | 'aborted';

export interface UploadSnapshot {
  videoId: string | null;
  phase: UploadPhase;
  recordedBytes: number;
  uploadedBytes: number;
  partsUploaded: number;
  partsTotal: number;
  error: string | null;
}

interface Part {
  number: number;
  blob: Blob;
  state: 'queued' | 'uploading' | 'done' | 'failed';
  loaded: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Streams a recording to object storage while it is still being recorded.
 *
 * MediaRecorder hands over a chunk every second. Chunks are buffered until they reach the
 * multipart minimum, then cut into a numbered part and uploaded in the background with
 * per-part retries. Part numbers follow recording order, so storage concatenates them
 * into the same bytes the recorder produced. When recording stops, only the tail (less
 * than one part) is left to send, so the video is playable about a second later instead
 * of after a full upload. A part that keeps failing pauses the upload in 'error'; retry()
 * resumes with the failed parts only, because the finished ones are already in storage.
 */
export class ChunkedUploader {
  private readonly opts: Required<UploaderOptions>;
  private partSize: number;
  private parts: Part[] = [];
  private pending: Blob[] = [];
  private pendingBytes = 0;
  private recordedBytes = 0;
  private inFlight = 0;
  private session: Promise<{ videoId: string }> | null = null;
  private videoId: string | null = null;
  private phase: UploadPhase = 'recording';
  private error: string | null = null;
  private durationSeconds: number | null = null;
  private listeners = new Set<(snapshot: UploadSnapshot) => void>();
  private waiters: (() => void)[] = [];

  constructor(
    private readonly transport: UploadTransport,
    options: UploaderOptions = {},
  ) {
    this.opts = {
      partSize: MIN_PART_SIZE,
      concurrency: 2,
      maxAttempts: 6,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      sleep: defaultSleep,
      ...options,
    };
    this.partSize = this.opts.partSize;
  }

  /** Opens the upload session early so the first part doesn't wait for it. */
  begin(): void {
    this.ensureSession().catch(() => undefined);
  }

  /** Adds a recorder chunk; cuts a part once enough bytes are buffered. */
  push(chunk: Blob): void {
    if (this.phase === 'aborted' || this.phase === 'done' || chunk.size === 0) return;
    this.recordedBytes += chunk.size;
    this.pending.push(chunk);
    this.pendingBytes += chunk.size;
    if (this.pendingBytes >= this.partSize) this.cutPart();
    this.notify();
  }

  /** Recording stopped: send the tail, wait for every part, then complete the upload. */
  finish(durationSeconds: number): Promise<Video> {
    this.durationSeconds = durationSeconds;
    if (this.pendingBytes > 0) this.cutPart();
    if (this.parts.length === 0) {
      this.fail(new Error('Nothing was recorded'));
      return Promise.reject(new Error('Nothing was recorded'));
    }
    return this.drainAndComplete();
  }

  /** Resumes after the 'error' phase. Only failed parts are sent again. */
  retry(): Promise<Video> | null {
    if (this.phase !== 'error') return null;
    for (const part of this.parts) {
      if (part.state === 'failed') {
        part.state = 'queued';
        part.loaded = 0;
      }
    }
    this.error = null;
    this.phase = this.durationSeconds === null ? 'recording' : 'finishing';
    this.pump();
    this.notify();
    return this.durationSeconds === null ? null : this.drainAndComplete();
  }

  /** Stops scheduling uploads. Returns the video id (if one was created) so it can be deleted. */
  async abort(): Promise<string | null> {
    this.phase = 'aborted';
    this.notify();
    if (!this.session) return this.videoId;
    try {
      return (await this.session).videoId;
    } catch {
      return null;
    }
  }

  subscribe(listener: (snapshot: UploadSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): UploadSnapshot {
    const uploadedBytes = this.parts.reduce(
      (sum, part) => sum + (part.state === 'done' ? part.blob.size : part.loaded),
      0,
    );
    return {
      videoId: this.videoId,
      phase: this.phase,
      recordedBytes: this.recordedBytes,
      uploadedBytes,
      partsUploaded: this.parts.filter((part) => part.state === 'done').length,
      partsTotal: this.parts.length,
      error: this.error,
    };
  }

  private cutPart(): void {
    const blob = new Blob(this.pending, { type: 'video/webm' });
    this.pending = [];
    this.pendingBytes = 0;
    this.parts.push({ number: this.parts.length + 1, blob, state: 'queued', loaded: 0 });
    this.pump();
  }

  private pump(): void {
    if (this.phase === 'error' || this.phase === 'aborted' || this.phase === 'done') return;
    while (this.inFlight < this.opts.concurrency) {
      const next = this.parts.find((part) => part.state === 'queued');
      if (!next) return;
      next.state = 'uploading';
      this.inFlight++;
      this.uploadPart(next).finally(() => {
        this.inFlight--;
        this.pump();
        this.notify();
      });
    }
  }

  private ensureSession(): Promise<{ videoId: string }> {
    if (!this.session) {
      this.session = this.withRetry(() => this.transport.start()).then(
        (started) => {
          this.videoId = started.videoId;
          if (started.partSize && started.partSize > this.partSize) this.partSize = started.partSize;
          this.notify();
          return { videoId: started.videoId };
        },
        (err) => {
          // Forget the failed attempt so the next caller starts a fresh one.
          this.session = null;
          throw err;
        },
      );
    }
    return this.session;
  }

  private async uploadPart(part: Part): Promise<void> {
    try {
      const { videoId } = await this.ensureSession();
      await this.withRetry(async () => {
        if (this.phase === 'aborted') throw new Error('Upload aborted');
        part.loaded = 0;
        // A fresh URL per attempt: an expired one is a common reason for the retry.
        const url = await this.transport.partUrl(videoId, part.number);
        await this.transport.putPart(url, part.blob, (loaded) => {
          part.loaded = loaded;
          this.notify();
        });
      });
      part.state = 'done';
      part.loaded = part.blob.size;
    } catch (err) {
      part.state = 'failed';
      part.loaded = 0;
      if (this.phase !== 'aborted') this.fail(err);
    }
  }

  private async drainAndComplete(): Promise<Video> {
    if (this.phase !== 'error' && this.phase !== 'aborted') this.phase = 'finishing';
    this.pump();
    this.notify();
    for (;;) {
      if (this.phase === 'aborted') throw new Error('Upload aborted');
      if (this.phase === 'error') throw new Error(this.error ?? 'Upload failed');
      if (this.parts.every((part) => part.state === 'done')) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      const { videoId } = await this.ensureSession();
      const video = await this.withRetry(() =>
        this.transport.complete(videoId, this.parts.length, this.durationSeconds ?? 0),
      );
      this.phase = 'done';
      this.notify();
      return video;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await operation();
      } catch (err) {
        if (attempt >= this.opts.maxAttempts || this.phase === 'aborted') throw err;
        const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (attempt - 1));
        await this.opts.sleep(delay);
      }
    }
  }

  private fail(err: unknown): void {
    this.phase = 'error';
    this.error = err instanceof Error ? err.message : String(err);
    this.notify();
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
