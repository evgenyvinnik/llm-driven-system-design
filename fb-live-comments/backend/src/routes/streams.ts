import { Router, Request, Response } from 'express';
import { streamService } from '../services/streamService.js';
import { commentService } from '../services/commentService.js';
import { reactionService } from '../services/reactionService.js';

const router = Router();

// Get all streams
router.get('/', async (_req: Request, res: Response) => {
  try {
    const streams = await streamService.getAllStreams();
    res.json(streams);
  } catch (error) {
    console.error('Error fetching streams:', error);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// Get live streams
router.get('/live', async (_req: Request, res: Response) => {
  try {
    const streams = await streamService.getLiveStreams();
    res.json(streams);
  } catch (error) {
    console.error('Error fetching live streams:', error);
    res.status(500).json({ error: 'Failed to fetch live streams' });
  }
});

// Get single stream
router.get('/:streamId', async (req: Request, res: Response) => {
  try {
    const stream = await streamService.getStream(req.params.streamId);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }
    res.json(stream);
  } catch (error) {
    console.error('Error fetching stream:', error);
    res.status(500).json({ error: 'Failed to fetch stream' });
  }
});

// Create stream
router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, creator_id, description, video_url } = req.body;
    if (!title || !creator_id) {
      return res.status(400).json({ error: 'Title and creator_id are required' });
    }
    const stream = await streamService.createStream(title, creator_id, description, video_url);
    res.status(201).json(stream);
  } catch (error) {
    console.error('Error creating stream:', error);
    res.status(500).json({ error: 'Failed to create stream' });
  }
});

// End stream
router.post('/:streamId/end', async (req: Request, res: Response) => {
  try {
    const stream = await streamService.endStream(req.params.streamId);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }
    res.json(stream);
  } catch (error) {
    console.error('Error ending stream:', error);
    res.status(500).json({ error: 'Failed to end stream' });
  }
});

// Get stream comments
router.get('/:streamId/comments', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const comments = await commentService.getRecentComments(req.params.streamId, limit);
    res.json(comments);
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Post comment (HTTP fallback, prefer WebSocket)
router.post('/:streamId/comments', async (req: Request, res: Response) => {
  try {
    const { user_id, content, parent_id } = req.body;
    if (!user_id || !content) {
      return res.status(400).json({ error: 'user_id and content are required' });
    }
    const comment = await commentService.createComment(
      req.params.streamId,
      user_id,
      content,
      parent_id
    );
    res.status(201).json(comment);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to post comment';
    console.error('Error posting comment:', error);
    res.status(400).json({ error: message });
  }
});

// Get stream reactions
router.get('/:streamId/reactions', async (req: Request, res: Response) => {
  try {
    const counts = await reactionService.getReactionCounts(req.params.streamId);
    res.json(counts);
  } catch (error) {
    console.error('Error fetching reactions:', error);
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

// Get stream metrics
router.get('/:streamId/metrics', async (req: Request, res: Response) => {
  try {
    const metrics = await streamService.getStreamMetrics(req.params.streamId);
    res.json(metrics);
  } catch (error) {
    console.error('Error fetching metrics:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

export default router;
