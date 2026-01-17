/**
 * Feed routes for the LinkedIn clone.
 * Handles post creation, feed generation with ranking,
 * and engagement features (likes, comments).
 *
 * @module routes/feed
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as feedService from '../services/feedService.js';
import { requireAuth } from '../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import {
  postsCreatedTotal,
  postLikesTotal,
  postCommentsTotal,
  feedGenerationDuration,
} from '../utils/metrics.js';
import {
  publishToQueue,
  QUEUES,
  PostCreatedEvent,
  NotificationEvent,
} from '../utils/rabbitmq.js';
import {
  createAuditLog,
  AuditEventType,
} from '../utils/audit.js';

const router = Router();

// Get feed
router.get('/', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 20;

    // Track feed generation time
    const startTime = Date.now();
    const posts = await feedService.getFeed(req.session.userId!, offset, limit);
    const duration = (Date.now() - startTime) / 1000;

    feedGenerationDuration.observe(duration);

    res.json({ posts });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get feed error');
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Create post
router.post('/', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const { content, imageUrl } = req.body;
    const userId = req.session.userId!;

    if (!content) {
      res.status(400).json({ error: 'Content required' });
      return;
    }

    const post = await feedService.createPost(userId, content, imageUrl);

    // Track metrics
    postsCreatedTotal.inc();

    // Publish post created event for feed fanout
    const postEvent: PostCreatedEvent = {
      type: 'post.created',
      postId: post.id,
      authorId: userId,
      idempotencyKey: uuidv4(),
      timestamp: new Date().toISOString(),
    };
    await publishToQueue(QUEUES.FEED_FANOUT, postEvent);

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.POST_CREATED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'post',
      targetId: post.id,
      action: 'create',
      details: { contentLength: content.length, hasImage: !!imageUrl },
    });

    logger.info({ userId, postId: post.id }, 'Post created');

    res.status(201).json({ post });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Create post error');
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// Get single post
router.get('/:id', readRateLimit, async (req: Request, res: Response) => {
  try {
    const post = await feedService.getPostById(parseInt(req.params.id));
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    res.json({ post });
  } catch (error) {
    logger.error({ error, postId: req.params.id }, 'Get post error');
    res.status(500).json({ error: 'Failed to get post' });
  }
});

// Update post
router.patch('/:id', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const { content, imageUrl } = req.body;
    const userId = req.session.userId!;
    const postId = parseInt(req.params.id);

    if (!content) {
      res.status(400).json({ error: 'Content required' });
      return;
    }

    const post = await feedService.updatePost(postId, userId, content, imageUrl);

    if (!post) {
      res.status(404).json({ error: 'Post not found or not authorized' });
      return;
    }

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.POST_UPDATED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'post',
      targetId: postId,
      action: 'update',
      details: { contentLength: content.length },
    });

    logger.info({ userId, postId }, 'Post updated');

    res.json({ post });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Update post error');
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// Delete post
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const postId = parseInt(req.params.id);

    const deleted = await feedService.deletePost(postId, userId);
    if (!deleted) {
      res.status(404).json({ error: 'Post not found or not authorized' });
      return;
    }

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.POST_DELETED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'post',
      targetId: postId,
      action: 'delete',
    });

    logger.info({ userId, postId }, 'Post deleted');

    res.json({ message: 'Post deleted' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Delete post error');
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// Like post
router.post('/:id/like', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const postId = parseInt(req.params.id);

    await feedService.likePost(userId, postId);

    // Track metrics
    postLikesTotal.inc();

    // Get post to notify author
    const post = await feedService.getPostById(postId);
    if (post && post.user_id !== userId) {
      // Publish notification to post author
      const notificationEvent: NotificationEvent = {
        type: 'notification.post_liked',
        recipientId: post.user_id,
        actorId: userId,
        entityId: postId,
        idempotencyKey: uuidv4(),
        timestamp: new Date().toISOString(),
      };
      await publishToQueue(QUEUES.NOTIFICATIONS, notificationEvent);
    }

    logger.debug({ userId, postId }, 'Post liked');

    res.json({ message: 'Post liked' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Like post error');
    res.status(500).json({ error: 'Failed to like post' });
  }
});

// Unlike post
router.delete('/:id/like', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const postId = parseInt(req.params.id);

    await feedService.unlikePost(userId, postId);

    logger.debug({ userId, postId }, 'Post unliked');

    res.json({ message: 'Post unliked' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Unlike post error');
    res.status(500).json({ error: 'Failed to unlike post' });
  }
});

// Get post likes
router.get('/:id/likes', readRateLimit, async (req: Request, res: Response) => {
  try {
    const users = await feedService.getPostLikes(parseInt(req.params.id));
    res.json({ users });
  } catch (error) {
    logger.error({ error, postId: req.params.id }, 'Get likes error');
    res.status(500).json({ error: 'Failed to get likes' });
  }
});

// Get post comments
router.get('/:id/comments', readRateLimit, async (req: Request, res: Response) => {
  try {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 50;

    const comments = await feedService.getPostComments(parseInt(req.params.id), offset, limit);
    res.json({ comments });
  } catch (error) {
    logger.error({ error, postId: req.params.id }, 'Get comments error');
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

// Add comment
router.post('/:id/comments', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const { content } = req.body;
    const userId = req.session.userId!;
    const postId = parseInt(req.params.id);

    if (!content) {
      res.status(400).json({ error: 'Content required' });
      return;
    }

    const comment = await feedService.addComment(postId, userId, content);

    // Track metrics
    postCommentsTotal.inc();

    // Get post to notify author
    const post = await feedService.getPostById(postId);
    if (post && post.user_id !== userId) {
      // Publish notification to post author
      const notificationEvent: NotificationEvent = {
        type: 'notification.post_commented',
        recipientId: post.user_id,
        actorId: userId,
        entityId: postId,
        idempotencyKey: uuidv4(),
        timestamp: new Date().toISOString(),
      };
      await publishToQueue(QUEUES.NOTIFICATIONS, notificationEvent);
    }

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.COMMENT_CREATED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'comment',
      targetId: comment.id,
      action: 'create',
      details: { postId, contentLength: content.length },
    });

    logger.debug({ userId, postId, commentId: comment.id }, 'Comment added');

    res.status(201).json({ comment });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Add comment error');
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Delete comment
router.delete('/comments/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const commentId = parseInt(req.params.id);

    const deleted = await feedService.deleteComment(commentId, userId);
    if (!deleted) {
      res.status(404).json({ error: 'Comment not found or not authorized' });
      return;
    }

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.COMMENT_DELETED,
      actorId: userId,
      actorIp: req.ip || undefined,
      targetType: 'comment',
      targetId: commentId,
      action: 'delete',
    });

    logger.debug({ userId, commentId }, 'Comment deleted');

    res.json({ message: 'Comment deleted' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Delete comment error');
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// Get user posts
router.get('/user/:userId', readRateLimit, async (req: Request, res: Response) => {
  try {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 20;

    const posts = await feedService.getUserPosts(parseInt(req.params.userId), offset, limit);
    res.json({ posts });
  } catch (error) {
    logger.error({ error, targetUserId: req.params.userId }, 'Get user posts error');
    res.status(500).json({ error: 'Failed to get user posts' });
  }
});

export default router;
