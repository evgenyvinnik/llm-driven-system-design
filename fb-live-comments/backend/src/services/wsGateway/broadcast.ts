/**
 * Broadcast Module
 *
 * Handles message batching and broadcasting to stream viewers.
 * Includes CommentBatcher and ReactionAggregator for efficient delivery.
 *
 * @module services/wsGateway/broadcast
 */

import { WebSocket } from 'ws';
import { redisPub } from '../../utils/redis.js';
import { ExtendedWebSocket, ICommentBatcher, IReactionAggregator } from './types.js';
import { CommentWithUser, ReactionCount, WSMessage } from '../../types/index.js';
import { logger } from '../../shared/index.js';

const _wsLogger = logger.child({ module: 'broadcast' });

/**
 * Broadcasts a message to all clients in a stream.
 *
 * @description Iterates through all WebSocket connections for a given stream
 * and sends the message to each client with an open connection. Connections
 * in other states (closing, closed) are skipped.
 *
 * @param connections - Map of stream IDs to sets of WebSocket connections
 * @param streamId - The stream to broadcast to
 * @param message - The WebSocket message to send (will be JSON serialized)
 * @returns void
 *
 * @example
 * ```typescript
 * broadcastToStream(connections, 'stream-123', {
 *   type: 'viewer_count',
 *   payload: { stream_id: 'stream-123', count: 500 },
 *   timestamp: Date.now(),
 * });
 * ```
 */
export function broadcastToStream(
  connections: Map<string, Set<ExtendedWebSocket>>,
  streamId: string,
  message: WSMessage
): void {
  const streamConnections = connections.get(streamId);
  if (!streamConnections) return;

  const data = JSON.stringify(message);
  streamConnections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

/**
 * Sends an error message to a client.
 *
 * @description Sends a JSON-formatted error message to a single WebSocket client.
 * The message includes an error code, human-readable message, and timestamp.
 *
 * @param ws - The WebSocket connection to send the error to
 * @param code - Error code identifier (e.g., 'INVALID_MESSAGE', 'NOT_IN_STREAM')
 * @param message - Human-readable error description
 * @returns void
 *
 * @example
 * ```typescript
 * sendError(ws, 'NOT_IN_STREAM', 'You must join a stream first');
 * sendError(ws, 'BANNED', 'You are banned from this stream');
 * ```
 */
export function sendError(ws: WebSocket, code: string, message: string): void {
  ws.send(
    JSON.stringify({
      type: 'error',
      payload: { code, message },
      timestamp: Date.now(),
    })
  );
}

/**
 * CommentBatcher - Batches comments for efficient delivery.
 *
 * @description Instead of sending each comment individually, comments are buffered
 * and published to Redis every 100ms (configurable via COMMENT_BATCH_INTERVAL_MS).
 * This reduces WebSocket message overhead and helps handle high-volume streams.
 * Redis Pub/Sub enables cross-instance delivery to all gateway servers.
 *
 * @example
 * ```typescript
 * const batcher = new CommentBatcher('stream-123');
 * batcher.start();
 *
 * // Comments are batched and published every 100ms
 * batcher.addComment({ id: '1', user_id: 'u1', content: 'Hello!' });
 * batcher.addComment({ id: '2', user_id: 'u2', content: 'Hi there!' });
 *
 * // On shutdown, flush remaining comments
 * batcher.stop();
 * ```
 */
export class CommentBatcher implements ICommentBatcher {
  /** Stream this batcher is associated with */
  private streamId: string;

  /** Buffer holding comments awaiting delivery */
  private buffer: CommentWithUser[] = [];

  /** Timer for periodic flushing */
  private intervalId: NodeJS.Timeout | null = null;

  /** Interval between batch deliveries in milliseconds */
  private batchInterval: number;

  constructor(streamId: string) {
    this.streamId = streamId;
    this.batchInterval = parseInt(process.env.COMMENT_BATCH_INTERVAL_MS || '100', 10);
  }

  /**
   * Adds a comment to the batch buffer.
   *
   * @description Appends a comment to the internal buffer. The comment will be
   * published to Redis during the next flush cycle (every 100ms by default).
   *
   * @param comment - The comment object including user information
   * @returns void
   */
  addComment(comment: CommentWithUser): void {
    this.buffer.push(comment);
  }

  /**
   * Starts the periodic flush timer.
   *
   * @description Begins the interval timer that flushes buffered comments
   * to Redis every batchInterval milliseconds. Must be called after construction.
   *
   * @returns void
   */
  start(): void {
    this.intervalId = setInterval(() => {
      this.flush();
    }, this.batchInterval);
  }

  /**
   * Stops the periodic flush timer and delivers any remaining comments.
   *
   * @description Clears the interval timer and immediately flushes any
   * remaining comments in the buffer. Should be called during shutdown.
   *
   * @returns void
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
   *
   * @description Publishes all buffered comments to Redis Pub/Sub channel.
   * The channel pattern is `stream:{streamId}:comments`. Called automatically
   * by the interval timer and on stop().
   *
   * @returns void
   * @private
   */
  private flush(): void {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    redisPub.publish(
      `stream:${this.streamId}:comments`,
      JSON.stringify({ stream_id: this.streamId, comments: batch })
    );
  }
}

/**
 * ReactionAggregator - Aggregates reactions for efficient delivery.
 *
 * @description Reactions are very high volume (potentially thousands per second).
 * Instead of sending individual reactions, this class aggregates counts by type
 * and publishes them every 500ms (configurable via REACTION_BATCH_INTERVAL_MS).
 * This dramatically reduces message overhead while keeping the UI responsive.
 *
 * @example
 * ```typescript
 * const aggregator = new ReactionAggregator('stream-123');
 * aggregator.start();
 *
 * // Reactions are aggregated and published every 500ms
 * aggregator.addReaction('like');
 * aggregator.addReaction('like');
 * aggregator.addReaction('heart');
 * // Publishes: { like: 2, heart: 1 }
 *
 * // On shutdown, flush remaining reactions
 * aggregator.stop();
 * ```
 */
export class ReactionAggregator implements IReactionAggregator {
  /** Stream this aggregator is associated with */
  private streamId: string;

  /** Aggregated counts by reaction type awaiting delivery */
  private counts: ReactionCount = {};

  /** Timer for periodic flushing */
  private intervalId: NodeJS.Timeout | null = null;

  /** Interval between batch deliveries in milliseconds */
  private batchInterval: number;

  constructor(streamId: string) {
    this.streamId = streamId;
    this.batchInterval = parseInt(process.env.REACTION_BATCH_INTERVAL_MS || '500', 10);
  }

  /**
   * Adds a reaction to the aggregation.
   *
   * @description Increments the count for the given reaction type. The aggregated
   * counts will be published to Redis during the next flush cycle.
   *
   * @param type - The reaction type (e.g., 'like', 'heart', 'wow')
   * @returns void
   */
  addReaction(type: string): void {
    this.counts[type] = (this.counts[type] || 0) + 1;
  }

  /**
   * Starts the periodic flush timer.
   *
   * @description Begins the interval timer that flushes aggregated reaction
   * counts to Redis every batchInterval milliseconds.
   *
   * @returns void
   */
  start(): void {
    this.intervalId = setInterval(() => {
      this.flush();
    }, this.batchInterval);
  }

  /**
   * Stops the periodic flush timer and delivers any remaining reactions.
   *
   * @description Clears the interval timer and immediately flushes any
   * remaining aggregated counts. Should be called during shutdown.
   *
   * @returns void
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
   *
   * @description Publishes aggregated reaction counts to Redis Pub/Sub channel.
   * The channel pattern is `stream:{streamId}:reactions`. Called automatically
   * by the interval timer and on stop().
   *
   * @returns void
   * @private
   */
  private flush(): void {
    if (Object.keys(this.counts).length === 0) return;

    const batch = this.counts;
    this.counts = {};

    redisPub.publish(
      `stream:${this.streamId}:reactions`,
      JSON.stringify({ stream_id: this.streamId, counts: batch })
    );
  }
}
