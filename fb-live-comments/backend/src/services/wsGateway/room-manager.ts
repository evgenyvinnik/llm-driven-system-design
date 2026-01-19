/**
 * Room Manager Module
 *
 * Handles stream room lifecycle, including join/leave operations,
 * viewer count tracking, and Redis Pub/Sub subscriptions.
 *
 * @module services/wsGateway/room-manager
 */

import { redisSub, redis } from '../../utils/redis.js';
import { ExtendedWebSocket, ICommentBatcher, IReactionAggregator } from './types.js';
import { CommentBatcher, ReactionAggregator, broadcastToStream } from './broadcast.js';
import { commentService } from '../commentService.js';
import { logger, peakViewersGauge } from '../../shared/index.js';

const wsLogger = logger.child({ module: 'room-manager' });

/**
 * Manages stream rooms, including joining, leaving, and resource cleanup.
 *
 * @description The RoomManager orchestrates the lifecycle of stream "rooms" - logical
 * groupings of WebSocket connections watching the same stream. It handles:
 * - Redis Pub/Sub subscriptions for cross-server communication
 * - Comment batching and reaction aggregation per stream
 * - Peak viewer tracking for analytics
 * - Resource cleanup when streams have no viewers
 *
 * @example
 * ```typescript
 * const roomManager = new RoomManager(connectionMap);
 * await roomManager.joinStream(ws, 'stream-123', addConnectionFn);
 * roomManager.leaveStream(ws, removeConnectionFn);
 * roomManager.shutdown();
 * ```
 */
export class RoomManager {
  /** Map of stream ID to connected clients */
  private connections: Map<string, Set<ExtendedWebSocket>>;

  /** Comment batchers per stream */
  private commentBatchers: Map<string, ICommentBatcher> = new Map();

  /** Reaction aggregators per stream */
  private reactionAggregators: Map<string, IReactionAggregator> = new Map();

  /** Peak viewer counts per stream */
  private peakViewers: Map<string, number> = new Map();

  constructor(connections: Map<string, Set<ExtendedWebSocket>>) {
    this.connections = connections;
  }

  /**
   * Adds a user to a stream room.
   *
   * @description Handles the complete stream join flow:
   * 1. If first viewer, sets up Redis Pub/Sub subscriptions and creates batchers
   * 2. Adds the connection to the stream's connection set
   * 3. Updates viewer count in Redis
   * 4. Tracks peak viewers for analytics
   * 5. Broadcasts updated viewer count to all watchers
   * 6. Sends recent comments to the newly joined viewer
   *
   * @param ws - The WebSocket connection joining the stream
   * @param streamId - The stream ID to join
   * @param addConnection - Callback function to add the connection to the manager
   * @returns Promise that resolves when join is complete
   *
   * @example
   * ```typescript
   * await roomManager.joinStream(ws, 'stream-123', (streamId, ws) => {
   *   connectionManager.addConnection(streamId, ws);
   * });
   * ```
   */
  async joinStream(
    ws: ExtendedWebSocket,
    streamId: string,
    addConnection: (streamId: string, ws: ExtendedWebSocket) => void
  ): Promise<void> {
    const isFirstViewer = !this.connections.has(streamId);

    if (isFirstViewer) {
      await redisSub.subscribe(`stream:${streamId}:comments`);
      await redisSub.subscribe(`stream:${streamId}:reactions`);

      const batcher = new CommentBatcher(streamId);
      this.commentBatchers.set(streamId, batcher);
      batcher.start();

      const aggregator = new ReactionAggregator(streamId);
      this.reactionAggregators.set(streamId, aggregator);
      aggregator.start();
    }

    addConnection(streamId, ws);

    const viewerCount = this.connections.get(streamId)!.size;
    await redis.hset(`stream:${streamId}`, 'viewer_count', viewerCount.toString());

    // Track peak viewers
    const currentPeak = this.peakViewers.get(streamId) || 0;
    if (viewerCount > currentPeak) {
      this.peakViewers.set(streamId, viewerCount);
      peakViewersGauge.labels(streamId).set(viewerCount);
    }

    // Broadcast viewer count
    broadcastToStream(this.connections, streamId, {
      type: 'viewer_count',
      payload: { stream_id: streamId, count: viewerCount },
      timestamp: Date.now(),
    });

    // Send recent comments to the new viewer
    const recentComments = await commentService.getRecentComments(streamId, 50);
    ws.send(
      JSON.stringify({
        type: 'comments_batch',
        payload: { stream_id: streamId, comments: recentComments.reverse() },
        timestamp: Date.now(),
      })
    );

    wsLogger.info({ userId: ws.userId, streamId, viewers: viewerCount }, 'User joined stream');
  }

  /**
   * Removes a user from a stream room.
   *
   * @description Handles the complete stream leave flow:
   * 1. Removes the connection from the stream's connection set
   * 2. If last viewer, unsubscribes from Redis Pub/Sub and stops batchers
   * 3. Otherwise, updates viewer count and broadcasts to remaining viewers
   * 4. Clears the stream/user session from the WebSocket
   *
   * @param ws - The WebSocket connection leaving the stream
   * @param removeConnection - Callback function that removes the connection and returns true if stream is now empty
   * @returns void
   *
   * @example
   * ```typescript
   * roomManager.leaveStream(ws, (streamId, ws) => {
   *   return connectionManager.removeConnection(streamId, ws);
   * });
   * ```
   */
  leaveStream(
    ws: ExtendedWebSocket,
    removeConnection: (streamId: string, ws: ExtendedWebSocket) => boolean
  ): void {
    if (!ws.streamId) return;

    const streamId = ws.streamId;
    const userId = ws.userId;
    const isEmpty = removeConnection(streamId, ws);

    if (isEmpty) {
      // Clean up when no viewers
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

      wsLogger.info({ streamId }, 'All viewers left, stream resources cleaned up');
    } else {
      // Update viewer count
      const viewerCount = this.connections.get(streamId)!.size;
      redis.hset(`stream:${streamId}`, 'viewer_count', viewerCount.toString());

      broadcastToStream(this.connections, streamId, {
        type: 'viewer_count',
        payload: { stream_id: streamId, count: viewerCount },
        timestamp: Date.now(),
      });
    }

    ws.streamId = undefined;
    ws.userId = undefined;

    wsLogger.debug({ userId, streamId }, 'User left stream');
  }

  /**
   * Gets the comment batcher for a stream.
   *
   * @description Retrieves the CommentBatcher instance associated with a stream.
   * Returns undefined if no viewers are watching the stream (batcher not initialized).
   *
   * @param streamId - The stream ID to get the batcher for
   * @returns The CommentBatcher instance or undefined if stream has no viewers
   */
  getCommentBatcher(streamId: string): ICommentBatcher | undefined {
    return this.commentBatchers.get(streamId);
  }

  /**
   * Gets the reaction aggregator for a stream.
   *
   * @description Retrieves the ReactionAggregator instance associated with a stream.
   * Returns undefined if no viewers are watching the stream (aggregator not initialized).
   *
   * @param streamId - The stream ID to get the aggregator for
   * @returns The ReactionAggregator instance or undefined if stream has no viewers
   */
  getReactionAggregator(streamId: string): IReactionAggregator | undefined {
    return this.reactionAggregators.get(streamId);
  }

  /**
   * Cleans up all batchers and aggregators during shutdown.
   *
   * @description Stops all comment batchers and reaction aggregators, ensuring any
   * buffered data is flushed before shutdown. Also clears the peak viewer tracking.
   * Should be called before closing WebSocket connections during graceful shutdown.
   *
   * @returns void
   */
  shutdown(): void {
    wsLogger.info('Flushing pending batches');

    this.commentBatchers.forEach((batcher, streamId) => {
      wsLogger.debug({ streamId }, 'Stopping comment batcher');
      batcher.stop();
    });

    this.reactionAggregators.forEach((aggregator, streamId) => {
      wsLogger.debug({ streamId }, 'Stopping reaction aggregator');
      aggregator.stop();
    });

    this.commentBatchers.clear();
    this.reactionAggregators.clear();
    this.peakViewers.clear();
  }
}
