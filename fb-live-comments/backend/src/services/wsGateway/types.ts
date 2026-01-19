/**
 * WebSocket Gateway Types Module
 *
 * Shared types and interfaces used across the WebSocket gateway modules.
 *
 * @module services/wsGateway/types
 */

import { WebSocket } from 'ws';
import type { CommentWithUser, ReactionCount } from '../../types/index.js';

/**
 * Extended WebSocket interface with stream session data.
 * Tracks which stream and user are associated with each connection.
 */
export interface ExtendedWebSocket extends WebSocket {
  /** Currently joined stream ID */
  streamId?: string;
  /** Authenticated user ID */
  userId?: string;
  /** Heartbeat status for connection health monitoring */
  isAlive?: boolean;
}

/**
 * Interface for comment batching operations.
 * Allows batching comments for efficient delivery.
 */
export interface ICommentBatcher {
  /** Adds a comment to the batch buffer */
  addComment(comment: CommentWithUser): void;
  /** Starts the periodic flush timer */
  start(): void;
  /** Stops the periodic flush timer and delivers any remaining comments */
  stop(): void;
}

/**
 * Interface for reaction aggregation operations.
 * Aggregates reactions for efficient delivery.
 */
export interface IReactionAggregator {
  /** Adds a reaction to the aggregation */
  addReaction(type: string): void;
  /** Starts the periodic flush timer */
  start(): void;
  /** Stops the periodic flush timer and delivers any remaining reactions */
  stop(): void;
}

/**
 * Configuration options for the WebSocket gateway.
 */
export interface GatewayConfig {
  /** Interval between heartbeat pings in milliseconds */
  heartbeatIntervalMs: number;
  /** Interval for comment batching in milliseconds */
  commentBatchIntervalMs: number;
  /** Interval for reaction aggregation in milliseconds */
  reactionBatchIntervalMs: number;
  /** Timeout for graceful shutdown in milliseconds */
  shutdownTimeoutMs: number;
}

/**
 * Default configuration values for the gateway.
 */
export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  heartbeatIntervalMs: 30000,
  commentBatchIntervalMs: 100,
  reactionBatchIntervalMs: 500,
  shutdownTimeoutMs: 10000,
};

/**
 * Maps WebSocket close codes to human-readable reasons for metrics.
 *
 * @description Converts numeric WebSocket close codes to descriptive string labels
 * for use in logging and Prometheus metrics. Covers standard RFC 6455 close codes.
 *
 * @param code - The numeric WebSocket close code (e.g., 1000, 1001, 1006)
 * @returns A human-readable string describing the close reason
 *
 * @example
 * ```typescript
 * const reason = getCloseReason(1000); // Returns 'normal'
 * const reason = getCloseReason(1006); // Returns 'abnormal'
 * wsConnectionsClosedCounter.labels(reason).inc();
 * ```
 */
export function getCloseReason(code: number): string {
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
