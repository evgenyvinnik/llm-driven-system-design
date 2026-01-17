/**
 * WebSocket Gateway Module
 *
 * Manages real-time bidirectional communication with clients for live comments
 * and reactions. Handles connection lifecycle, message routing, and coordinates
 * with Redis Pub/Sub for horizontal scaling across multiple server instances.
 *
 * Key features:
 * - Comment batching to reduce message overhead
 * - Reaction aggregation for high-volume updates
 * - Heartbeat monitoring for connection health
 * - Redis Pub/Sub for multi-instance synchronization
 * - Prometheus metrics for observability
 * - Graceful shutdown for zero message loss
 *
 * @module services/wsGateway
 */

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
import {
  logger,
  wsConnectionsGauge,
  wsConnectionsOpenedCounter,
  wsConnectionsClosedCounter,
  wsMessageSizeHistogram,
  reactionsPostedCounter,
  peakViewersGauge,
} from '../shared/index.js';

const wsLogger = logger.child({ module: 'websocket-gateway' });

/**
 * Extended WebSocket interface with stream session data.
 * Tracks which stream and user are associated with each connection.
 */
interface ExtendedWebSocket extends WebSocket {
  /** Currently joined stream ID */
  streamId?: string;
  /** Authenticated user ID */
  userId?: string;
  /** Heartbeat status for connection health monitoring */
  isAlive?: boolean;
}

/**
 * WebSocket Gateway for real-time communication.
 * Manages connections, message routing, and coordinates batching/aggregation.
 */
export class WebSocketGateway {
  /** WebSocket server instance */
  private wss: WebSocketServer;

  /** Map of stream ID to connected clients for efficient broadcasting */
  private connections: Map<string, Set<ExtendedWebSocket>> = new Map();

  /** Comment batchers per stream for efficient delivery */
  private commentBatchers: Map<string, CommentBatcher> = new Map();

  /** Reaction aggregators per stream for high-volume handling */
  private reactionAggregators: Map<string, ReactionAggregator> = new Map();

  /** Heartbeat interval timer */
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /** Peak viewer counts per stream for metrics */
  private peakViewers: Map<string, number> = new Map();

  /** Flag indicating if shutdown is in progress */
  private isShuttingDown = false;

  /**
   * Creates a new WebSocket gateway attached to an HTTP server.
   * Initializes WebSocket handling, Redis Pub/Sub, and heartbeat monitoring.
   *
   * @param server - HTTP server to attach WebSocket server to
   */
  constructor(server: unknown) {
    this.wss = new WebSocketServer({ server: server as import('http').Server });
    this.setupWebSocket();
    this.setupRedisPubSub();
    this.startHeartbeat();

    wsLogger.info('WebSocket gateway initialized');
  }

  /**
   * Sets up WebSocket event handlers for new connections.
   * Handles connection, message, close, and error events.
   */
  private setupWebSocket(): void {
    this.wss.on('connection', (ws: ExtendedWebSocket, req: IncomingMessage) => {
      if (this.isShuttingDown) {
        wsLogger.warn('Rejecting connection during shutdown');
        ws.close(1001, 'Server is shutting down');
        return;
      }

      wsLogger.info({ remoteAddress: req.socket.remoteAddress }, 'New WebSocket connection');
      wsConnectionsOpenedCounter.inc();

      ws.isAlive = true;

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const size = data.length;
          wsMessageSizeHistogram.labels('inbound', 'message').observe(size);

          const message: WSMessage = JSON.parse(data.toString());
          await this.handleMessage(ws, message);
        } catch (error) {
          wsLogger.error({ error: (error as Error).message }, 'Error handling message');
          this.sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message');
        }
      });

      ws.on('close', (code, reason) => {
        wsConnectionsClosedCounter.labels(this.getCloseReason(code)).inc();
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        wsLogger.error({ error: error.message }, 'WebSocket error');
        wsConnectionsClosedCounter.labels('error').inc();
        this.handleDisconnect(ws);
      });
    });
  }

  /**
   * Maps WebSocket close codes to human-readable reasons for metrics.
   */
  private getCloseReason(code: number): string {
    switch (code) {
      case 1000: return 'normal';
      case 1001: return 'going_away';
      case 1002: return 'protocol_error';
      case 1003: return 'unsupported_data';
      case 1006: return 'abnormal';
      case 1007: return 'invalid_payload';
      case 1008: return 'policy_violation';
      case 1009: return 'message_too_big';
      case 1011: return 'server_error';
      default: return 'unknown';
    }
  }

  /**
   * Sets up Redis Pub/Sub listeners for cross-instance message distribution.
   * Subscribes to comment and reaction channels per stream.
   */
  private setupRedisPubSub(): void {
    redisSub.on('message', (channel: string, message: string) => {
      // Channel format: stream:{streamId}:comments or stream:{streamId}:reactions
      const parts = channel.split(':');
      if (parts.length < 3) return;

      const streamId = parts[1];
      const type = parts[2];

      const payload = JSON.parse(message);
      const msgSize = message.length;

      if (type === 'comments') {
        wsMessageSizeHistogram.labels('outbound', 'comments_batch').observe(msgSize);
        this.broadcastToStream(streamId, {
          type: 'comments_batch',
          payload,
          timestamp: Date.now(),
        });
      } else if (type === 'reactions') {
        wsMessageSizeHistogram.labels('outbound', 'reactions_batch').observe(msgSize);
        this.broadcastToStream(streamId, {
          type: 'reactions_batch',
          payload,
          timestamp: Date.now(),
        });
      }
    });
  }

  /**
   * Starts the heartbeat monitoring interval.
   * Terminates connections that fail to respond to pings within 30 seconds.
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws: ExtendedWebSocket) => {
        if (ws.isAlive === false) {
          wsLogger.debug({ userId: ws.userId }, 'Terminating unresponsive connection');
          this.handleDisconnect(ws);
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  /**
   * Routes incoming WebSocket messages to appropriate handlers.
   *
   * @param ws - Client WebSocket connection
   * @param message - Parsed WebSocket message
   */
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

  /**
   * Handles a user joining a stream.
   * Sets up subscriptions, initializes batchers, and sends initial data.
   *
   * @param ws - Client WebSocket connection
   * @param payload - Join request with stream_id and user_id
   */
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

    // Update viewer count and metrics
    const viewerCount = this.connections.get(stream_id)!.size;
    await redis.hset(`stream:${stream_id}`, 'viewer_count', viewerCount.toString());

    // Update connection gauge
    wsConnectionsGauge.labels(stream_id).set(viewerCount);

    // Track peak viewers
    const currentPeak = this.peakViewers.get(stream_id) || 0;
    if (viewerCount > currentPeak) {
      this.peakViewers.set(stream_id, viewerCount);
      peakViewersGauge.labels(stream_id).set(viewerCount);
    }

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

    wsLogger.info({ userId: user_id, streamId: stream_id, viewers: viewerCount }, 'User joined stream');
  }

  /**
   * Handles a user leaving a stream.
   * Cleans up subscriptions and batchers when no viewers remain.
   *
   * @param ws - Client WebSocket connection
   */
  private handleLeaveStream(ws: ExtendedWebSocket): void {
    if (!ws.streamId) return;

    const streamId = ws.streamId;
    const userId = ws.userId;
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

        // Reset gauge to 0
        wsConnectionsGauge.labels(streamId).set(0);

        wsLogger.info({ streamId }, 'All viewers left, stream resources cleaned up');
      } else {
        // Update viewer count
        const viewerCount = connections.size;
        redis.hset(`stream:${streamId}`, 'viewer_count', viewerCount.toString());
        wsConnectionsGauge.labels(streamId).set(viewerCount);

        this.broadcastToStream(streamId, {
          type: 'viewer_count',
          payload: { stream_id: streamId, count: viewerCount },
          timestamp: Date.now(),
        });
      }
    }

    ws.streamId = undefined;
    ws.userId = undefined;

    wsLogger.debug({ userId, streamId }, 'User left stream');
  }

  /**
   * Handles a new comment submission from a client.
   * Validates the request and adds to the comment batcher for delivery.
   *
   * @param ws - Client WebSocket connection
   * @param payload - Comment content and metadata
   */
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

  /**
   * Handles a reaction submission from a client.
   * Adds to the reaction aggregator for batched delivery.
   *
   * @param ws - Client WebSocket connection
   * @param payload - Reaction type and target
   */
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

      // Record metric
      reactionsPostedCounter.labels(payload.stream_id, payload.reaction_type).inc();

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

  /**
   * Handles client disconnection.
   * Delegates to handleLeaveStream for cleanup.
   *
   * @param ws - Disconnected client WebSocket
   */
  private handleDisconnect(ws: ExtendedWebSocket): void {
    this.handleLeaveStream(ws);
  }

  /**
   * Sends an error message to a client.
   *
   * @param ws - Client WebSocket connection
   * @param code - Error code for client handling
   * @param message - Human-readable error message
   */
  private sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(
      JSON.stringify({
        type: 'error',
        payload: { code, message },
        timestamp: Date.now(),
      })
    );
  }

  /**
   * Broadcasts a message to all clients in a stream.
   *
   * @param streamId - Target stream ID
   * @param message - Message to broadcast
   */
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

  /**
   * Gets the current viewer count for a stream.
   *
   * @param streamId - Stream to check
   * @returns Number of connected viewers
   */
  getViewerCount(streamId: string): number {
    return this.connections.get(streamId)?.size || 0;
  }

  /**
   * Gets total connection count across all streams.
   *
   * @returns Total number of active WebSocket connections
   */
  getTotalConnections(): number {
    let total = 0;
    this.connections.forEach((conns) => {
      total += conns.size;
    });
    return total;
  }

  /**
   * Performs graceful shutdown of the WebSocket gateway.
   *
   * 1. Stops accepting new connections
   * 2. Flushes all pending batches to ensure no message loss
   * 3. Sends shutdown notification to all connected clients
   * 4. Closes all connections gracefully
   * 5. Cleans up resources
   *
   * @param timeoutMs - Maximum time to wait for cleanup (default: 10000ms)
   * @returns Promise that resolves when shutdown is complete
   */
  async gracefulShutdown(timeoutMs = 10000): Promise<void> {
    wsLogger.info('Starting graceful WebSocket shutdown');
    this.isShuttingDown = true;

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Flush all batchers and aggregators
    wsLogger.info('Flushing pending batches');
    const flushPromises: Promise<void>[] = [];

    this.commentBatchers.forEach((batcher, streamId) => {
      wsLogger.debug({ streamId }, 'Stopping comment batcher');
      batcher.stop();
    });

    this.reactionAggregators.forEach((aggregator, streamId) => {
      wsLogger.debug({ streamId }, 'Stopping reaction aggregator');
      aggregator.stop();
    });

    // Give time for final publishes to propagate
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Notify all clients and close connections
    wsLogger.info({ connectionCount: this.getTotalConnections() }, 'Closing all connections');

    const closePromises: Promise<void>[] = [];
    this.wss.clients.forEach((ws) => {
      closePromises.push(
        new Promise<void>((resolve) => {
          // Send shutdown message
          try {
            ws.send(
              JSON.stringify({
                type: 'error',
                payload: { code: 'SERVER_SHUTDOWN', message: 'Server is shutting down' },
                timestamp: Date.now(),
              })
            );
          } catch {
            // Ignore send errors during shutdown
          }

          // Close with going away code
          ws.close(1001, 'Server shutting down');

          // Set a timeout in case close doesn't complete
          const timeout = setTimeout(() => {
            ws.terminate();
            resolve();
          }, 1000);

          ws.once('close', () => {
            clearTimeout(timeout);
            resolve();
          });
        })
      );
    });

    // Wait for all connections to close with overall timeout
    await Promise.race([
      Promise.all(closePromises),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    // Close the WebSocket server
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => {
        if (err) {
          wsLogger.error({ error: err.message }, 'Error closing WebSocket server');
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Clear all maps
    this.connections.clear();
    this.commentBatchers.clear();
    this.reactionAggregators.clear();
    this.peakViewers.clear();

    wsLogger.info('WebSocket gateway shutdown complete');
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
  /** Stream this batcher is associated with */
  private streamId: string;

  /** Buffer holding comments awaiting delivery */
  private buffer: CommentWithUser[] = [];

  /** Timer for periodic flushing */
  private intervalId: NodeJS.Timeout | null = null;

  /** Interval between batch deliveries in milliseconds */
  private batchInterval: number;

  /**
   * Creates a new comment batcher for a stream.
   *
   * @param streamId - Stream to batch comments for
   */
  constructor(streamId: string) {
    this.streamId = streamId;
    this.batchInterval = parseInt(process.env.COMMENT_BATCH_INTERVAL_MS || '100', 10);
  }

  /**
   * Adds a comment to the batch buffer.
   *
   * @param comment - Comment to queue for delivery
   */
  addComment(comment: CommentWithUser): void {
    this.buffer.push(comment);
  }

  /**
   * Starts the periodic flush timer.
   * Should be called when first viewer joins the stream.
   */
  start(): void {
    this.intervalId = setInterval(() => {
      this.flush();
    }, this.batchInterval);
  }

  /**
   * Stops the periodic flush timer and delivers any remaining comments.
   * Should be called when last viewer leaves the stream or during shutdown.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.flush();
  }

  /**
   * Flushes the buffer by publishing to Redis for cross-instance delivery.
   * Called automatically on interval and on stop.
   */
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
  /** Stream this aggregator is associated with */
  private streamId: string;

  /** Aggregated counts by reaction type awaiting delivery */
  private counts: ReactionCount = {};

  /** Timer for periodic flushing */
  private intervalId: NodeJS.Timeout | null = null;

  /** Interval between batch deliveries in milliseconds */
  private batchInterval: number;

  /**
   * Creates a new reaction aggregator for a stream.
   *
   * @param streamId - Stream to aggregate reactions for
   */
  constructor(streamId: string) {
    this.streamId = streamId;
    this.batchInterval = parseInt(process.env.REACTION_BATCH_INTERVAL_MS || '500', 10);
  }

  /**
   * Adds a reaction to the aggregation.
   * Increments the count for the specified reaction type.
   *
   * @param type - Reaction type to increment
   */
  addReaction(type: string): void {
    this.counts[type] = (this.counts[type] || 0) + 1;
  }

  /**
   * Starts the periodic flush timer.
   * Should be called when first viewer joins the stream.
   */
  start(): void {
    this.intervalId = setInterval(() => {
      this.flush();
    }, this.batchInterval);
  }

  /**
   * Stops the periodic flush timer and delivers any remaining reactions.
   * Should be called when last viewer leaves the stream or during shutdown.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.flush();
  }

  /**
   * Flushes aggregated counts by publishing to Redis for cross-instance delivery.
   * Called automatically on interval and on stop.
   */
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
