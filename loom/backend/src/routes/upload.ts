import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { uploadLimiter } from '../services/rateLimiter.js';
import { logger } from '../services/logger.js';
import { getPresignedDownloadUrl } from '../services/storageService.js';
import { requireVideoAccess, isUuid } from '../services/videoAccess.js';
import { mapVideoRow } from '../services/videoMapper.js';
import {
  startUpload,
  presignPart,
  listParts,
  completeUpload,
  UploadError,
} from '../services/uploadService.js';
import {
  uploadPartUrlsIssued,
  uploadCompletions,
  uploadFinalizeDuration,
} from '../services/metrics.js';

const router = Router();

/** Maps UploadError to its status; anything else is a 500 (or 503 if storage is unreachable). */
function sendError(res: Response, err: unknown, action: string): void {
  if (err instanceof UploadError) {
    res.status(err.status).json({ error: err.message, ...err.details });
    return;
  }
  const breakerOpen = (err as { code?: string })?.code === 'EOPENBREAKER';
  logger.error({ err }, `Failed to ${action}`);
  res
    .status(breakerOpen ? 503 : 500)
    .json({ error: breakerOpen ? 'Storage temporarily unavailable' : 'Internal server error' });
}

function videoIdFrom(req: Request, res: Response): string | null {
  const videoId = req.body?.videoId ?? req.params.videoId;
  if (!isUuid(videoId)) {
    res.status(400).json({ error: 'videoId must be a UUID' });
    return null;
  }
  return videoId;
}

// POST /api/upload/multipart/start - Open (or return the already open) multipart upload
router.post('/multipart/start', requireAuth, uploadLimiter, async (req: Request, res: Response) => {
  const videoId = videoIdFrom(req, res);
  if (!videoId) return;
  try {
    const upload = await startUpload(videoId, req.session.userId!);
    res.status(upload.created ? 201 : 200).json({
      uploadId: upload.uploadId,
      objectName: upload.objectName,
      partSize: upload.partSize,
      maxParts: upload.maxParts,
    });
  } catch (err) {
    sendError(res, err, 'start upload');
  }
});

// POST /api/upload/multipart/part-url - Presign the PUT for one part
router.post('/multipart/part-url', requireAuth, async (req: Request, res: Response) => {
  const videoId = videoIdFrom(req, res);
  if (!videoId) return;
  try {
    const part = await presignPart(videoId, req.session.userId!, req.body?.partNumber);
    uploadPartUrlsIssued.inc();
    res.json(part);
  } catch (err) {
    sendError(res, err, 'presign part');
  }
});

// GET /api/upload/multipart/:videoId/parts - Parts storage already holds (for resuming)
router.get('/multipart/:videoId/parts', requireAuth, async (req: Request, res: Response) => {
  const videoId = videoIdFrom(req, res);
  if (!videoId) return;
  try {
    res.json({ parts: await listParts(videoId, req.session.userId!) });
  } catch (err) {
    sendError(res, err, 'list parts');
  }
});

// POST /api/upload/complete - Verify the parts in storage, stitch them, make the video playable
router.post('/complete', requireAuth, async (req: Request, res: Response) => {
  const videoId = videoIdFrom(req, res);
  if (!videoId) return;
  const end = uploadFinalizeDuration.startTimer();
  try {
    const { video, replayed } = await completeUpload(videoId, req.session.userId!, {
      partCount: req.body?.partCount,
      durationSeconds: req.body?.durationSeconds,
    });
    uploadCompletions.inc({ outcome: replayed ? 'replayed' : 'completed' });
    if (!replayed) end();
    res.json({ video: mapVideoRow(video) });
  } catch (err) {
    if (err instanceof UploadError && err.status === 409) {
      uploadCompletions.inc({ outcome: err.details?.missingParts ? 'incomplete' : 'rejected' });
    }
    sendError(res, err, 'complete upload');
  }
});

// GET /api/upload/download/:videoId - Presigned playback URL (owner, or a valid share grant)
router.get('/download/:videoId', requireVideoAccess('viewer'), async (_req: Request, res: Response) => {
  try {
    const video = res.locals.videoAccess!.video;
    if (video.status !== 'processing' && video.status !== 'ready') {
      res.status(409).json({ error: 'Video is not ready yet' });
      return;
    }
    if (!video.storage_path) {
      res.status(404).json({ error: 'Video file not available' });
      return;
    }
    const downloadUrl = await getPresignedDownloadUrl(video.storage_path as string);
    res.json({ downloadUrl });
  } catch (err) {
    sendError(res, err, 'get download URL');
  }
});

export default router;
