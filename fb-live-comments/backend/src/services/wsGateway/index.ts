/**
 * WebSocket Gateway Module
 *
 * Main entry point for the WebSocket gateway. Manages real-time bidirectional
 * communication with clients for live comments and reactions.
 *
 * @module services/wsGateway
 */

import { redisSub } from '../../utils/redis.js';
import { commentService } from '../commentService.js';
import { reactionService } from '../reactionService.js';
import { WSMessage, JoinStreamPayload, PostCommentPayload, ReactPayload } from '../../types/index.js';
import { logger, wsMessageSizeHistogram, reactionsPostedCounter } from '../../shared/index.js';

import { ExtendedWebSocket } from './types.js';
import { ConnectionManager } from './connection-manager.js';
import { RoomManager } from './room-manager.js';
import { broadcastToStream, sendError } from './broadcast.js';
import { rejectIfBanned, validateUserSession } from './moderation.js';

const wsLogger = logger.child({ module: 'websocket-gateway' });

/**
 * WebSocket Gateway for real-time communication.
 *
 * @description The WebSocketGateway is the main entry point for real-time features.
 * It orchestrates WebSocket connections, Redis Pub/Sub for cross-server communication,
 * and handles the full lifecycle of comments and reactions. Key responsibilities:
 *
 * - **Connection Management**: Tracks connections per stream with heartbeat monitoring
 * - **Message Routing**: Routes incoming messages to appropriate handlers
 * - **Comment Flow**: Validates, persists, and batches comments for delivery
 * - **Reaction Flow**: Validates, persists, and aggregates reactions
 * - **Redis Pub/Sub**: Subscribes to comment/reaction channels for multi-server broadcasting
 *
 * @example
 * ```typescript
 * import http from 'http';
 *
 * const server = http.createServer(app);
 * const wsGateway = new WebSocketGateway(server);
 *
 * // Check metrics
 * console.log(`Total connections: ${wsGateway.getTotalConnections()}`);
 * console.log(`Stream viewers: ${wsGateway.getViewerCount('stream-123')}`);
 *
 * // Graceful shutdown
 * process.on('SIGTERM', async () => {
 *   await wsGateway.gracefulShutdown(5000);
 * });
 * ```
 */
export class WebSocketGateway {
  private connectionManager: ConnectionManager;
  private roomManager: RoomManager;

  constructor(server: unknown) {
    this.connectionManager = new ConnectionManager(server);
    this.roomManager = new RoomManager(this.connectionManager.getConnections());
    this.connectionManager.setup(this.handleMessage.bind(this), this.handleDisconnect.bind(this));
    this.setupRedisPubSub();
    wsLogger.info('WebSocket gateway initialized');
  }

  private setupRedisPubSub(): void {
    redisSub.on('message', (channel: string, message: string) => {
      const parts = channel.split(':');
      if (parts.length < 3) return;

      const [, streamId, type] = parts;
      const payload = JSON.parse(message);
      wsMessageSizeHistogram.labels('outbound', `${type}_batch`).observe(message.length);

      if (type === 'comments' || type === 'reactions') {
        broadcastToStream(this.connectionManager.getConnections(), streamId, {
          type: `${type}_batch` as 'comments_batch' | 'reactions_batch',
          payload,
          timestamp: Date.now(),
        });
      }
    });
  }

  private async handleMessage(ws: ExtendedWebSocket, data: Buffer): Promise<void> {
    try {
      const message: WSMessage = JSON.parse(data.toString());
      await this.routeMessage(ws, message);
    } catch (error) {
      wsLogger.error({ error: (error as Error).message }, 'Error handling message');
      sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message');
    }
  }

  private async routeMessage(ws: ExtendedWebSocket, message: WSMessage): Promise<void> {
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
        sendError(ws, 'UNKNOWN_TYPE', `Unknown message type: ${message.type}`);
    }
  }

  private async handleJoinStream(ws: ExtendedWebSocket, payload: JoinStreamPayload): Promise<void> {
    const { stream_id, user_id } = payload;
    if (await rejectIfBanned(ws, user_id, stream_id)) return;
    if (ws.streamId) this.handleLeaveStream(ws);

    ws.streamId = stream_id;
    ws.userId = user_id;
    await this.roomManager.joinStream(ws, stream_id, this.connectionManager.addConnection.bind(this.connectionManager));
  }

  private handleLeaveStream(ws: ExtendedWebSocket): void {
    this.roomManager.leaveStream(ws, this.connectionManager.removeConnection.bind(this.connectionManager));
  }

  private async handlePostComment(ws: ExtendedWebSocket, payload: PostCommentPayload): Promise<void> {
    if (!validateUserSession(ws, payload.stream_id, payload.user_id)) return;

    try {
      const comment = await commentService.createComment(
        payload.stream_id, payload.user_id, payload.content, payload.parent_id
      );
      this.roomManager.getCommentBatcher(payload.stream_id)?.addComment(comment);
    } catch (error) {
      sendError(ws, 'POST_FAILED', error instanceof Error ? error.message : 'Failed to post comment');
    }
  }

  private async handleReaction(ws: ExtendedWebSocket, payload: ReactPayload): Promise<void> {
    // Same binding as comments: the reaction must name the stream and user this
    // socket joined, or a socket joined elsewhere could react into a stream whose
    // join-time ban check it never passed.
    if (!validateUserSession(ws, payload.stream_id, payload.user_id)) return;

    try {
      await reactionService.addReaction(payload.stream_id, payload.user_id, payload.reaction_type, payload.comment_id);
      reactionsPostedCounter.labels(payload.stream_id, payload.reaction_type).inc();
      this.roomManager.getReactionAggregator(payload.stream_id)?.addReaction(payload.reaction_type);
    } catch (error) {
      sendError(ws, 'REACTION_FAILED', error instanceof Error ? error.message : 'Failed to add reaction');
    }
  }

  private handleDisconnect(ws: ExtendedWebSocket): void {
    this.handleLeaveStream(ws);
  }

  /**
   * Gets the number of viewers for a stream.
   *
   * @description Returns the count of WebSocket connections currently watching
   * the specified stream. Useful for displaying viewer counts in the UI.
   *
   * @param streamId - The stream ID to get viewer count for
   * @returns The number of active connections for the stream
   */
  getViewerCount(streamId: string): number {
    return this.connectionManager.getViewerCount(streamId);
  }

  /**
   * Gets the total number of connections across all streams.
   *
   * @description Sums up all active WebSocket connections across all streams.
   * Useful for monitoring overall gateway load and capacity planning.
   *
   * @returns The total count of active WebSocket connections
   */
  getTotalConnections(): number {
    return this.connectionManager.getTotalConnections();
  }

  /**
   * Gracefully shuts down the WebSocket gateway.
   *
   * @description Performs a graceful shutdown by:
   * 1. Flushing all pending comment batches and reaction aggregations
   * 2. Waiting briefly for flush to complete
   * 3. Closing all WebSocket connections with shutdown notification
   * 4. Shutting down the WebSocket server
   *
   * @param timeoutMs - Maximum time to wait for graceful shutdown (default: 10000ms)
   * @returns Promise that resolves when shutdown is complete
   *
   * @example
   * ```typescript
   * process.on('SIGTERM', async () => {
   *   await wsGateway.gracefulShutdown(5000);
   *   process.exit(0);
   * });
   * ```
   */
  async gracefulShutdown(timeoutMs = 10000): Promise<void> {
    wsLogger.info('Starting graceful WebSocket shutdown');
    this.roomManager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.connectionManager.shutdown(timeoutMs);
    wsLogger.info('WebSocket gateway shutdown complete');
  }
}

export { ExtendedWebSocket } from './types.js';
