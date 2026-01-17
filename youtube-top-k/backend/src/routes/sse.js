import express from 'express';
import { TrendingService } from '../services/trendingService.js';

const router = express.Router();

/**
 * GET /api/sse/trending
 * Server-Sent Events endpoint for real-time trending updates
 */
router.get('/trending', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');

  // Disable response buffering
  res.flushHeaders();

  // Send initial connection message
  const initialData = JSON.stringify({
    type: 'connected',
    message: 'Connected to trending updates',
    timestamp: new Date().toISOString(),
  });
  res.write(`data: ${initialData}\n\n`);

  // Send current trending data immediately
  const trendingService = TrendingService.getInstance();
  const currentTrending = {
    type: 'trending-update',
    timestamp: new Date().toISOString(),
    trending: Object.fromEntries(
      ['all', 'music', 'gaming', 'sports', 'news', 'entertainment', 'education'].map(
        (category) => [category, trendingService.getTrending(category)]
      )
    ),
  };
  res.write(`data: ${JSON.stringify(currentTrending)}\n\n`);

  // Register client for future updates
  trendingService.registerSSEClient(res);

  // Handle client disconnect
  req.on('close', () => {
    console.log('SSE client closed connection');
  });
});

/**
 * GET /api/sse/heartbeat
 * Simple SSE heartbeat for connection testing
 */
router.get('/heartbeat', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendHeartbeat = () => {
    const data = JSON.stringify({
      type: 'heartbeat',
      timestamp: new Date().toISOString(),
    });
    res.write(`data: ${data}\n\n`);
  };

  // Send immediate heartbeat
  sendHeartbeat();

  // Send heartbeat every 10 seconds
  const intervalId = setInterval(sendHeartbeat, 10000);

  req.on('close', () => {
    clearInterval(intervalId);
    console.log('Heartbeat client disconnected');
  });
});

export default router;
