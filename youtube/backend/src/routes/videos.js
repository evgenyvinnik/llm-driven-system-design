import express from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import {
  getVideo,
  getVideos,
  updateVideo,
  deleteVideo,
  reactToVideo,
  getUserReaction,
  addComment,
  getComments,
  deleteComment,
  likeComment,
} from '../services/metadata.js';
import { getStreamingInfo, recordView, updateWatchProgress, getWatchProgress } from '../services/streaming.js';

const router = express.Router();

// Get videos (with optional filters)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { page, limit, channelId, search, category, orderBy, order } = req.query;

    const result = await getVideos({
      page: parseInt(page, 10) || 1,
      limit: Math.min(parseInt(limit, 10) || 20, 50),
      channelId,
      search,
      category,
      orderBy,
      order,
    });

    res.json(result);
  } catch (error) {
    console.error('Get videos error:', error);
    res.status(500).json({ error: 'Failed to get videos' });
  }
});

// Get video by ID
router.get('/:videoId', optionalAuth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const video = await getVideo(videoId);

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Get user's reaction if logged in
    let userReaction = null;
    let watchProgress = null;

    if (req.user) {
      userReaction = await getUserReaction(req.user.id, videoId);
      watchProgress = await getWatchProgress(req.user.id, videoId);
    }

    res.json({
      ...video,
      userReaction,
      watchProgress,
    });
  } catch (error) {
    console.error('Get video error:', error);
    res.status(500).json({ error: 'Failed to get video' });
  }
});

// Get streaming info for video
router.get('/:videoId/stream', optionalAuth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const streamingInfo = await getStreamingInfo(videoId);

    if (!streamingInfo) {
      return res.status(404).json({ error: 'Video not found or not ready' });
    }

    res.json(streamingInfo);
  } catch (error) {
    console.error('Get streaming info error:', error);
    res.status(500).json({ error: 'Failed to get streaming info' });
  }
});

// Record video view
router.post('/:videoId/view', optionalAuth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const { watchDuration, watchPercentage } = req.body;

    await recordView(
      videoId,
      req.user?.id,
      parseInt(watchDuration, 10) || 0,
      parseFloat(watchPercentage) || 0
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Record view error:', error);
    res.status(500).json({ error: 'Failed to record view' });
  }
});

// Update watch progress
router.post('/:videoId/progress', authenticate, async (req, res) => {
  try {
    const { videoId } = req.params;
    const { position, duration } = req.body;

    await updateWatchProgress(
      req.user.id,
      videoId,
      parseInt(position, 10) || 0,
      parseInt(duration, 10) || 0
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

// Update video
router.patch('/:videoId', authenticate, async (req, res) => {
  try {
    const { videoId } = req.params;
    const { title, description, categories, tags, visibility } = req.body;

    const video = await updateVideo(videoId, req.user.id, {
      title,
      description,
      categories,
      tags,
      visibility,
    });

    if (!video) {
      return res.status(404).json({ error: 'Video not found or unauthorized' });
    }

    res.json(video);
  } catch (error) {
    console.error('Update video error:', error);
    res.status(500).json({ error: 'Failed to update video' });
  }
});

// Delete video
router.delete('/:videoId', authenticate, async (req, res) => {
  try {
    const { videoId } = req.params;
    const success = await deleteVideo(videoId, req.user.id);

    if (!success) {
      return res.status(404).json({ error: 'Video not found or unauthorized' });
    }

    res.json({ message: 'Video deleted' });
  } catch (error) {
    console.error('Delete video error:', error);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

// Like/dislike video
router.post('/:videoId/react', authenticate, async (req, res) => {
  try {
    const { videoId } = req.params;
    const { reaction } = req.body;

    if (!['like', 'dislike'].includes(reaction)) {
      return res.status(400).json({ error: 'Invalid reaction type' });
    }

    const result = await reactToVideo(req.user.id, videoId, reaction);
    res.json(result);
  } catch (error) {
    console.error('React to video error:', error);
    res.status(500).json({ error: 'Failed to react to video' });
  }
});

// Get comments
router.get('/:videoId/comments', optionalAuth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const { page, limit, parentId } = req.query;

    const result = await getComments(
      videoId,
      parseInt(page, 10) || 1,
      Math.min(parseInt(limit, 10) || 20, 50),
      parentId || null
    );

    res.json(result);
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

// Add comment
router.post('/:videoId/comments', authenticate, async (req, res) => {
  try {
    const { videoId } = req.params;
    const { text, parentId } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Comment text is required' });
    }

    const comment = await addComment(req.user.id, videoId, text.trim(), parentId || null);
    res.status(201).json(comment);
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Delete comment
router.delete('/:videoId/comments/:commentId', authenticate, async (req, res) => {
  try {
    const { commentId } = req.params;
    const success = await deleteComment(commentId, req.user.id);

    if (!success) {
      return res.status(404).json({ error: 'Comment not found or unauthorized' });
    }

    res.json({ message: 'Comment deleted' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// Like comment
router.post('/:videoId/comments/:commentId/like', authenticate, async (req, res) => {
  try {
    const { commentId } = req.params;
    const result = await likeComment(req.user.id, commentId);
    res.json(result);
  } catch (error) {
    console.error('Like comment error:', error);
    res.status(500).json({ error: 'Failed to like comment' });
  }
});

export default router;
