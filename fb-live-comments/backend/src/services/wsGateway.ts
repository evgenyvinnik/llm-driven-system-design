import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { redisSub, redisPub, redis } from '../utils/redis.js';
import { commentService } from './commentService.js';
import { reactionService } from './reactionService.js';
import { userService } from './userService.js';
import {
  WSMessage,
  WSMessageType,
  CommentWithUser,
  ReactionCount,
  JoinStreamPayload,
  PostCommentPayload,
  ReactPayload,
} from '../types/index.js';

interface ExtendedWebSocket extends WebSocket {
  streamId?: string;
  userId?: string;
  isAlive?: boolean;
}

export class WebSocketGateway {
  private wss: WebSocketServer;
  private connections: Map<string, Set<ExtendedWebSocket>> = new Map();
  private commentBatchers: Map<string, CommentBatcher> = new Map();
  private reactionAggregators: Map<string, ReactionAggregator> = new Map();

  constructor(server: unknown) {
    this.wss = new WebSocketServer({ server: server as Parameters<typeof WebSocketServer>[0]['server'] });
    this.setupWebSocket();
    this.setupRedisPubSub();
    this.startHeartbeat();
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: ExtendedWebSocket, req: IncomingMessage) => {
      console.log('New WebSocket connection from:', req.socket.remoteAddress);

      ws.isAlive = true;

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const message: WSMessage = JSON.parse(data.toString());
          await this.handleMessage(ws, message);
        } catch (error) {
          console.error('Error handling message:', error);
          this.sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message');
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.handleDisconnect(ws);
      });
    });
  }

  private setupRedisPubSub(): void {
    redisSub.on('message', (channel: string, message: string) => {
      // Channel format: stream:{streamId}:comments or stream:{streamId}:reactions
      const parts = channel.split(':');
      if (parts.length < 3) return;

      const streamId = parts[1];
      const type = parts[2];

      if (type === 'comments') {
        this.broadcastToStream(streamId, {
          type: 'comments_batch',
          payload: JSON.parse(message),
          timestamp: Date.now(),
        });
      } else if (type === 'reactions') {
        this.broadcastToStream(streamId, {
          type: 'reactions_batch',
          payload: JSON.parse(message),
          timestamp: Date.now(),
        });
      }
    });
  }

  private startHeartbeat(): void {
    setInterval(() => {
      this.wss.clients.forEach((ws: ExtendedWebSocket) => {
        if (ws.isAlive === false) {
          this.handleDisconnect(ws);
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  private async handleMessage(ws: ExtendedWebSocket, message: WSMessage): Promise<void> {
    switch (message.type) {
      case 'join_stream':
        await this.handleJoinStream(ws, message.payload as JoinStreamPayload);
        break;
      case 'leave_stream':
        this.handleLeaveStream(ws);
        break;
      case 'post_comment':
        await this.handlePostComment(ws, message.payload as PostCommentPayload);
        break;
      case 'react':
        await this.handleReaction(ws, message.payload as ReactPayload);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      default:
        this.sendError(ws, 'UNKNOWN_TYPE', `Unknown message type: ${message.type}`);
    }
  }

  private async handleJoinStream(ws: ExtendedWebSocket, payload: JoinStreamPayload): Promise<void> {
    const { stream_id, user_id } = payload;

    // Check if user is banned
    const isBanned = await userService.isBanned(user_id, stream_id);
    if (isBanned) {
      this.sendError(ws, 'BANNED', 'You are banned from this stream');
      return;
    }

    // Leave previous stream if any
    if (ws.streamId) {
      this.handleLeaveStream(ws);
    }

    ws.streamId = stream_id;
    ws.userId = user_id;

    // Add to connections
    if (!this.connections.has(stream_id)) {
      this.connections.set(stream_id, new Set());
      await redisSub.subscribe(`stream:${stream_id}:comments`);
      await redisSub.subscribe(`stream:${stream_id}:reactions`);
    }
    this.connections.get(stream_id)!.add(ws);

    // Initialize batcher and aggregator if needed
    if (!this.commentBatchers.has(stream_id)) {
      const batcher = new CommentBatcher(stream_id);
      this.commentBatchers.set(stream_id, batcher);
      batcher.start();
    }

    if (!this.reactionAggregators.has(stream_id)) {
      const aggregator = new ReactionAggregator(stream_id);
      this.reactionAggregators.set(stream_id, aggregator);
      aggregator.start();
    }

    // Update viewer count
    const viewerCount = this.connections.get(stream_id)!.size;
    await redis.hset(`stream:${stream_id}`, 'viewer_count', viewerCount.toString());

    // Broadcast viewer count
    this.broadcastToStream(stream_id, {
      type: 'viewer_count',
      payload: { stream_id, count: viewerCount },
      timestamp: Date.now(),
    });

    // Send recent comments to the new viewer
    const recentComments = await commentService.getRecentComments(stream_id, 50);
    ws.send(
      JSON.stringify({
        type: 'comments_batch',
        payload: { stream_id, comments: recentComments.reverse() },
        timestamp: Date.now(),
      })
    );

    console.log(`User ${user_id} joined stream ${stream_id}. Viewers: ${viewerCount}`);
  }

  private handleLeaveStream(ws: ExtendedWebSocket): void {
    if (!ws.streamId) return;

    const streamId = ws.streamId;
    const connections = this.connections.get(streamId);

    if (connections) {
      connections.delete(ws);

      if (connections.size === 0) {
        // Clean up when no viewers
        this.connections.delete(streamId);
        redisSub.unsubscribe(`stream:${streamId}:comments`);
        redisSub.unsubscribe(`stream:${streamId}:reactions`);

        const batcher = this.commentBatchers.get(streamId);
        if (batcher) {
          batcher.stop();
          this.commentBatchers.delete(streamId);
        }

        const aggregator = this.reactionAggregators.get(streamId);
        if (aggregator) {
          aggregator.stop();
          this.reactionAggregators.delete(streamId);
        }
      } else {
        // Update viewer count
        const viewerCount = connections.size;
        redis.hset(`stream:${streamId}`, 'viewer_count', viewerCount.toString());
        this.broadcastToStream(streamId, {
          type: 'viewer_count',
          payload: { stream_id: streamId, count: viewerCount },
          timestamp: Date.now(),
        });
      }
    }

    ws.streamId = undefined;
    ws.userId = undefined;
  }

  private async handlePostComment(ws: ExtendedWebSocket, payload: PostCommentPayload): Promise<void> {
    if (!ws.streamId || !ws.userId) {
      this.sendError(ws, 'NOT_IN_STREAM', 'You must join a stream first');
      return;
    }

    if (ws.streamId !== payload.stream_id || ws.userId !== payload.user_id) {
      this.sendError(ws, 'INVALID_REQUEST', 'Stream or user mismatch');
      return;
    }

    try {
      const comment = await commentService.createComment(
        payload.stream_id,
        payload.user_id,
        payload.content,
        payload.parent_id
      );

      // Add to batcher for fan-out
      const batcher = this.commentBatchers.get(payload.stream_id);
      if (batcher) {
        batcher.addComment(comment);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to post comment';
      this.sendError(ws, 'POST_FAILED', message);
    }
  }

  private async handleReaction(ws: ExtendedWebSocket, payload: ReactPayload): Promise<void> {
    if (!ws.streamId || !ws.userId) {
      this.sendError(ws, 'NOT_IN_STREAM', 'You must join a stream first');
      return;
    }

    try {
      await reactionService.addReaction(
        payload.stream_id,
        payload.user_id,
        payload.reaction_type,
        payload.comment_id
      );

      // Add to aggregator
      const aggregator = this.reactionAggregators.get(payload.stream_id);
      if (aggregator) {
        aggregator.addReaction(payload.reaction_type);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add reaction';
      this.sendError(ws, 'REACTION_FAILED', message);
    }
  }

  private handleDisconnect(ws: ExtendedWebSocket): void {
    this.handleLeaveStream(ws);
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(
      JSON.stringify({
        type: 'error',
        payload: { code, message },
        timestamp: Date.now(),
      })
    );
  }

  private broadcastToStream(streamId: string, message: WSMessage): void {
    const connections = this.connections.get(streamId);
    if (!connections) return;

    const data = JSON.stringify(message);
    connections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }

  getViewerCount(streamId: string): number {
    return this.connections.get(streamId)?.size || 0;
  }
}

/**
 * CommentBatcher - Batches comments for efficient delivery
 *
 * Instead of sending each comment individually, we batch them
 * and send every 100ms. This reduces WebSocket message overhead
 * and helps handle high-volume streams.
 */
class CommentBatcher {
  private streamId: string;
  private buffer: CommentWithUser[] = [];
  private intervalId: NodeJS.Timeout | null = null;
  private batchInterval: number;

  constructor(streamId: string) {
    this.streamId = streamId;
    this.batchInterval = parseInt(process.env.COMMENT_BATCH_INTERVAL_MS || '100', 10);
  }

  addComment(comment: CommentWithUser): void {
    this.buffer.push(comment);
  }

  start(): void {
    this.intervalId = setInterval(() => {
      this.flush();
    }, this.batchInterval);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    // Publish to Redis for distribution across server instances
    redisPub.publish(
      `stream:${this.streamId}:comments`,
      JSON.stringify({ stream_id: this.streamId, comments: batch })
    );
  }
}

/**
 * ReactionAggregator - Aggregates reactions for efficient delivery
 *
 * Reactions are very high volume (thousands per second).
 * We aggregate counts and send every 500ms.
 */
class ReactionAggregator {
  private streamId: string;
  private counts: ReactionCount = {};
  private intervalId: NodeJS.Timeout | null = null;
  private batchInterval: number;

  constructor(streamId: string) {
    this.streamId = streamId;
    this.batchInterval = parseInt(process.env.REACTION_BATCH_INTERVAL_MS || '500', 10);
  }

  addReaction(type: string): void {
    this.counts[type] = (this.counts[type] || 0) + 1;
  }

  start(): void {
    this.intervalId = setInterval(() => {
      this.flush();
    }, this.batchInterval);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.flush();
  }

  private flush(): void {
    if (Object.keys(this.counts).length === 0) return;

    const batch = this.counts;
    this.counts = {};

    // Publish to Redis for distribution across server instances
    redisPub.publish(
      `stream:${this.streamId}:reactions`,
      JSON.stringify({ stream_id: this.streamId, counts: batch })
    );
  }
}
