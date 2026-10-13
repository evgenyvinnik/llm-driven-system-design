import { Router, Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import { query, getClient } from '../services/db.js';
import { storeOriginalImage, deleteObject, FILTERS } from '../services/storage.js';
import { cacheGet, cacheSet, postCacheKey, invalidatePostCache } from '../services/redis.js';
import { requireAuth, optionalAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { postRateLimiter, likeRateLimiter } from '../services/rateLimiter.js';
import { enqueueOutboxEvent, kickOutboxRelay, OUTBOX_EVENT_TYPES } from '../services/outbox.js';
import {
  isValidIdempotencyKey,
  fingerprintCreatePost,
  findIdempotencyKey,
  claimIdempotencyKey,
  StoredIdempotencyKey,
} from '../services/idempotency.js';
import { findVisiblePost, canViewPost, isUuid } from '../services/visibility.js';
import { removePostFromTimelines } from '../services/feedService.js';
import logger from '../services/logger.js';
import {
  postsCreatedTotal,
  postsDeletedTotal,
  likesTotal,
  likesDuplicateTotal,
  idempotentReplays,
} from '../services/metrics.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const MAX_CAPTION_LENGTH = 2200;
const POST_CACHE_TTL_SECONDS = 300;

interface PostRow {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  profile_picture_url: string | null;
  is_private: boolean;
  caption: string;
  location: string | null;
  status: string;
  like_count: number;
  comment_count: number;
  created_at: Date;
}

interface MediaRow {
  id: string;
  media_type: string;
  media_url: string;
  thumbnail_url: string;
  filter_applied: string;
  width: number;
  height: number;
  order_index: number;
}

interface LikeUserRow {
  id: string;
  username: string;
  display_name: string;
  profile_picture_url: string | null;
  created_at: Date;
}

interface PostDetail {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  profilePictureUrl: string | null;
  caption: string;
  location: string | null;
  status: string;
  likeCount: number;
  commentCount: number;
  createdAt: Date;
  media: {
    id: string;
    mediaType: string;
    mediaUrl: string;
    thumbnailUrl: string;
    filterApplied: string;
    width: number;
    height: number;
    orderIndex: number;
  }[];
}

/** Cached post detail plus the field that decides who may see it. */
interface CachedPostEntry {
  post: PostDetail;
  authorIsPrivate: boolean;
}

const viewerOf = (req: Request): { userId?: string; role?: string } => {
  const session = (req as AuthenticatedRequest).session;
  return { userId: session?.userId, role: session?.role };
};

/** Loads a post with author and media straight from PostgreSQL. */
async function loadPostDetail(postId: string): Promise<CachedPostEntry | null> {
  const postResult = await query<PostRow>(
    `SELECT p.*, u.username, u.display_name, u.profile_picture_url, u.is_private
     FROM posts p
     JOIN users u ON p.user_id = u.id
     WHERE p.id = $1`,
    [postId]
  );
  if (postResult.rows.length === 0) return null;
  const post = postResult.rows[0];

  const mediaResult = await query<MediaRow>('SELECT * FROM post_media WHERE post_id = $1 ORDER BY order_index', [
    postId,
  ]);

  return {
    authorIsPrivate: post.is_private,
    post: {
      id: post.id,
      userId: post.user_id,
      username: post.username,
      displayName: post.display_name,
      profilePictureUrl: post.profile_picture_url,
      caption: post.caption,
      location: post.location,
      status: post.status,
      likeCount: post.like_count,
      commentCount: post.comment_count,
      createdAt: post.created_at,
      media: mediaResult.rows.map((m: MediaRow) => ({
        id: m.id,
        mediaType: m.media_type,
        mediaUrl: m.media_url,
        thumbnailUrl: m.thumbnail_url,
        filterApplied: m.filter_applied,
        width: m.width,
        height: m.height,
        orderIndex: m.order_index,
      })),
    },
  };
}

/** Responds to a retried create with the post the first attempt made (or 422 on key reuse). */
async function replayCreate(res: Response, stored: StoredIdempotencyKey, requestHash: string): Promise<void> {
  if (stored.requestHash !== requestHash) {
    idempotentReplays.labels('mismatch').inc();
    res.status(422).json({ error: 'Idempotency-Key was already used with a different request' });
    return;
  }
  const entry = stored.postId ? await loadPostDetail(stored.postId) : null;
  if (!entry) {
    res.status(409).json({ error: 'The original request for this Idempotency-Key no longer has a post' });
    return;
  }
  idempotentReplays.labels('replayed').inc();
  res.setHeader('Idempotent-Replayed', 'true');
  res.status(202).json({
    post: entry.post,
    message:
      entry.post.status === 'processing' ? 'Post is being processed. Images will be available shortly.' : undefined,
  });
}

const removeObjects = (keys: string[]): Promise<unknown> => Promise.all(keys.map((key) => deleteObject(key)));

/**
 * Create post with async image processing.
 *
 * 1. Validate, and if the Idempotency-Key was seen before, replay that result.
 * 2. Upload originals to object storage (outside any transaction - no pooled connection is
 *    held during a multi-megabyte upload).
 * 3. One transaction: post row ('processing'), media rows, idempotency key, outbox event.
 * 4. Nudge the outbox relay and answer 202; the worker publishes the post later.
 */
router.post(
  '/',
  requireAuth as RequestHandler,
  postRateLimiter,
  upload.array('media', 10),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    const body = req.body as { caption?: string; location?: string; filters?: string };
    const caption = (body.caption || '').trim();
    const location = body.location?.trim() || null;

    if (files.length === 0) {
      res.status(400).json({ error: 'At least one image is required' });
      return;
    }
    if (files.some((file) => !file.mimetype.startsWith('image/'))) {
      res.status(415).json({ error: 'Only image uploads are supported for posts' });
      return;
    }
    if (caption.length > MAX_CAPTION_LENGTH) {
      res.status(400).json({ error: `Caption must be at most ${MAX_CAPTION_LENGTH} characters` });
      return;
    }

    let filters: string[] = [];
    if (body.filters) {
      try {
        const parsed: unknown = JSON.parse(body.filters);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        filters = parsed.map((name) => String(name));
      } catch {
        res.status(400).json({ error: 'filters must be a JSON array of filter names' });
        return;
      }
    }
    if (filters.some((name) => !(name in FILTERS))) {
      res.status(400).json({ error: `Unknown filter. Valid filters: ${Object.keys(FILTERS).join(', ')}` });
      return;
    }
    const filterNames = files.map((_, i) => filters[i] || 'none');

    const idempotencyKey = req.get('Idempotency-Key');
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      res.status(400).json({ error: 'Idempotency-Key must be 8-255 characters of [A-Za-z0-9._:-]' });
      return;
    }
    const requestHash = idempotencyKey
      ? fingerprintCreatePost({ caption, location, filters: filterNames, files })
      : null;

    try {
      if (idempotencyKey && requestHash) {
        const stored = await findIdempotencyKey(userId, idempotencyKey);
        if (stored) {
          await replayCreate(res, stored, requestHash);
          return;
        }
      }

      // Upload originals before opening a transaction.
      const uploadedKeys: string[] = [];
      try {
        for (const file of files) {
          const { key } = await storeOriginalImage(file.buffer, file.originalname, file.mimetype);
          uploadedKeys.push(key);
        }
      } catch (error) {
        await removeObjects(uploadedKeys);
        logger.error({ type: 'post_upload_error', error: (error as Error).message, userId }, 'Original upload failed');
        res.status(503).json({ error: 'Media storage is unavailable. Please retry.' });
        return;
      }

      const mediaItems = uploadedKeys.map((originalKey, i) => ({
        originalKey,
        filterName: filterNames[i],
        orderIndex: i,
      }));

      const client = await getClient();
      let post: PostRow;
      try {
        await client.query('BEGIN');

        const postResult = await client.query<PostRow>(
          `INSERT INTO posts (user_id, caption, location, status)
           VALUES ($1, $2, $3, 'processing')
           RETURNING *`,
          [userId, caption, location]
        );
        post = postResult.rows[0];

        for (const item of mediaItems) {
          await client.query(
            `INSERT INTO post_media (post_id, media_type, original_key, filter_applied, order_index)
             VALUES ($1, 'image', $2, $3, $4)`,
            [post.id, item.originalKey, item.filterName, item.orderIndex]
          );
        }

        if (idempotencyKey && requestHash) {
          const claimed = await claimIdempotencyKey(client, userId, idempotencyKey, requestHash, post.id);
          if (!claimed) {
            // A concurrent retry with the same key committed first: undo ours, answer with theirs.
            await client.query('ROLLBACK');
            await removeObjects(uploadedKeys);
            const winner = await findIdempotencyKey(userId, idempotencyKey);
            if (winner) {
              await replayCreate(res, winner, requestHash);
            } else {
              res.status(409).json({ error: 'A request with this Idempotency-Key is still in progress' });
            }
            return;
          }
        }

        await enqueueOutboxEvent(client, {
          aggregateId: post.id,
          eventType: OUTBOX_EVENT_TYPES.POST_MEDIA_UPLOADED,
          payload: { postId: post.id, userId, mediaItems },
        });

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        await removeObjects(uploadedKeys);
        throw error;
      } finally {
        client.release();
      }

      kickOutboxRelay();
      postsCreatedTotal.inc();

      logger.info(
        {
          type: 'post_created',
          postId: post.id,
          userId,
          mediaCount: files.length,
          status: 'processing',
          idempotencyKey: idempotencyKey ? 'present' : 'absent',
        },
        `Post created (processing): ${post.id}`
      );

      // 202 Accepted: the post exists, its images are processed asynchronously
      res.status(202).json({
        post: {
          id: post.id,
          userId: post.user_id,
          caption: post.caption,
          location: post.location,
          status: 'processing',
          likeCount: post.like_count,
          commentCount: post.comment_count,
          createdAt: post.created_at,
          media: mediaItems.map((m) => ({
            orderIndex: m.orderIndex,
            filterApplied: m.filterName,
            status: 'processing',
          })),
        },
        message: 'Post is being processed. Images will be available shortly.',
      });
    } catch (error) {
      const err = error as Error;
      logger.error(
        {
          type: 'post_create_error',
          error: err.message,
          userId,
        },
        `Create post error: ${err.message}`
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Get single post
router.get('/:postId', optionalAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = req.params.postId as string;
    const viewer = viewerOf(req);
    if (!isUuid(postId)) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    let entry = await cacheGet<CachedPostEntry>(postCacheKey(postId));
    if (!entry) {
      entry = await loadPostDetail(postId);
      // Only published posts are cached: a cached 'processing' entry would hide the images
      // for the whole TTL after the worker finishes.
      if (entry && entry.post.status === 'published') {
        await cacheSet(postCacheKey(postId), entry, POST_CACHE_TTL_SECONDS);
      }
    }

    const visible =
      entry &&
      (await canViewPost(viewer, {
        authorId: entry.post.userId,
        status: entry.post.status,
        authorIsPrivate: entry.authorIsPrivate,
      }));
    if (!entry || !visible) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    let isLiked = false;
    let isSaved = false;
    if (viewer.userId) {
      const state = await query<{ is_liked: boolean; is_saved: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2) AS is_liked,
                EXISTS (SELECT 1 FROM saved_posts WHERE user_id = $1 AND post_id = $2) AS is_saved`,
        [viewer.userId, postId]
      );
      isLiked = state.rows[0]?.is_liked ?? false;
      isSaved = state.rows[0]?.is_saved ?? false;
    }

    res.json({ post: { ...entry.post, isLiked, isSaved } });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'post_get_error',
        error: err.message,
        postId: req.params.postId,
      },
      `Get post error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete post
router.delete('/:postId', requireAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = req.params.postId as string;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;

    // Check ownership
    const postCheck = isUuid(postId)
      ? await query<{ user_id: string }>('SELECT user_id FROM posts WHERE id = $1', [postId])
      : { rows: [] as { user_id: string }[] };
    if (postCheck.rows.length === 0) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    const authorId = postCheck.rows[0].user_id;
    if (authorId !== userId && authReq.session.role !== 'admin') {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    // Delete post (cascade will handle media, likes, comments, idempotency key)
    await query('DELETE FROM posts WHERE id = $1', [postId]);

    // Increment metrics
    postsDeletedTotal.inc();

    logger.info(
      {
        type: 'post_deleted',
        postId,
        userId,
      },
      `Post deleted: ${postId}`
    );

    // Derived state: timelines (batched per follower page) and the post cache.
    await invalidatePostCache(postId);
    await removePostFromTimelines(authorId, postId).catch((err: Error) =>
      logger.warn({ error: err.message, postId }, 'Timeline cleanup after delete failed')
    );

    res.json({ message: 'Post deleted' });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'post_delete_error',
        error: err.message,
        postId: req.params.postId,
      },
      `Delete post error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Like post - IDEMPOTENT operation
 *
 * A like is set membership, so the endpoint is naturally idempotent: INSERT ... ON CONFLICT
 * DO NOTHING RETURNING tells us in one statement whether this request created the like.
 * A double-tap or a client retry gets 200 with idempotent: true and never double-counts.
 */
router.post(
  '/:postId/like',
  requireAuth as RequestHandler,
  likeRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = req.params.postId as string;
      const viewer = viewerOf(req);
      const userId = viewer.userId!;

      if (!(await findVisiblePost(postId, viewer))) {
        res.status(404).json({ error: 'Post not found' });
        return;
      }

      const result = await query<{ id: string }>(
        'INSERT INTO likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
        [userId, postId]
      );

      if (result.rows.length === 0) {
        likesDuplicateTotal.inc();
        logger.debug({ type: 'like_duplicate', postId, userId }, `Duplicate like attempt: ${postId}`);
        res.json({ message: 'Post already liked', idempotent: true });
        return;
      }

      likesTotal.labels('like').inc();
      logger.info({ type: 'like_created', postId, userId }, `Post liked: ${postId}`);

      // Clear post cache to reflect new like count
      await invalidatePostCache(postId);

      res.json({ message: 'Post liked', idempotent: false });
    } catch (error) {
      const err = error as Error;
      logger.error(
        {
          type: 'like_error',
          error: err.message,
          postId: req.params.postId,
        },
        `Like post error: ${err.message}`
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * Unlike post - IDEMPOTENT operation
 */
router.delete('/:postId/like', requireAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = req.params.postId as string;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;

    if (!isUuid(postId)) {
      res.json({ message: 'Post was not liked', idempotent: true });
      return;
    }

    // Delete like - returns deleted row if it existed
    const result = await query<{ id: string }>(
      'DELETE FROM likes WHERE user_id = $1 AND post_id = $2 RETURNING id',
      [userId, postId]
    );

    if (result.rows.length === 0) {
      logger.debug({ type: 'unlike_idempotent', postId, userId }, `Idempotent unlike: ${postId}`);
      res.json({ message: 'Post was not liked', idempotent: true });
      return;
    }

    likesTotal.labels('unlike').inc();
    logger.info({ type: 'unlike', postId, userId }, `Post unliked: ${postId}`);

    await invalidatePostCache(postId);

    res.json({ message: 'Post unliked', idempotent: false });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'unlike_error',
        error: err.message,
        postId: req.params.postId,
      },
      `Unlike post error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save post
router.post('/:postId/save', requireAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = req.params.postId as string;
    const viewer = viewerOf(req);

    if (!(await findVisiblePost(postId, viewer))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    await query('INSERT INTO saved_posts (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      viewer.userId,
      postId,
    ]);

    res.json({ message: 'Post saved' });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'save_error',
        error: err.message,
        postId: req.params.postId,
      },
      `Save post error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unsave post
router.delete('/:postId/save', requireAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = req.params.postId as string;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;

    if (isUuid(postId)) {
      await query('DELETE FROM saved_posts WHERE user_id = $1 AND post_id = $2', [userId, postId]);
    }

    res.json({ message: 'Post unsaved' });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'unsave_error',
        error: err.message,
        postId: req.params.postId,
      },
      `Unsave post error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get post likes
router.get('/:postId/likes', optionalAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = req.params.postId as string;
    const { cursor, limit = '20' } = req.query as { cursor?: string; limit?: string };
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    if (!(await findVisiblePost(postId, viewerOf(req)))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    let queryText = `
      SELECT u.id, u.username, u.display_name, u.profile_picture_url, l.created_at
      FROM likes l
      JOIN users u ON l.user_id = u.id
      WHERE l.post_id = $1
    `;
    const params: unknown[] = [postId];

    if (cursor) {
      queryText += ` AND l.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY l.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limitNum + 1);

    const result = await query<LikeUserRow>(queryText, params);

    const hasMore = result.rows.length > limitNum;
    const likes = result.rows.slice(0, limitNum);

    res.json({
      likes: likes.map((l: LikeUserRow) => ({
        id: l.id,
        username: l.username,
        displayName: l.display_name,
        profilePictureUrl: l.profile_picture_url,
      })),
      nextCursor: hasMore ? likes[likes.length - 1].created_at : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(
      {
        type: 'get_likes_error',
        error: err.message,
        postId: req.params.postId,
      },
      `Get likes error: ${err.message}`
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available filters
router.get('/filters/list', (_req: Request, res: Response): void => {
  res.json({ filters: Object.keys(FILTERS) });
});

export default router;
