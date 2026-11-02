/**
 * @fileoverview Type definitions for the collaboration service.
 * @description Contains interfaces for WebSocket client connections, document state,
 * and Redis pub/sub message formats used in real-time collaborative editing.
 * @module services/collaboration/types
 */

import type { WebSocket } from 'ws';
import type { PresenceState, UserPublic, Operation } from '../../types/index.js';

/**
 * Represents a connected WebSocket client with their session info.
 * @description Tracks the WebSocket connection, authenticated user, current document,
 * and last activity timestamp for timeout management.
 *
 * @interface ClientConnection
 * @property {WebSocket} ws - The active WebSocket connection instance
 * @property {UserPublic} user - The authenticated user's public profile data
 * @property {string | null} documentId - UUID of the document currently being edited, or null if not subscribed
 * @property {boolean} canEdit - Whether the user may send OPERATIONs to documentId (owner or 'edit' grant)
 * @property {number} accessCheckedAt - Unix timestamp (ms) when canEdit was last read from the database
 * @property {number} lastActivity - Unix timestamp (ms) of last message received, used for idle timeout
 *
 * @example
 * const client: ClientConnection = {
 *   ws: websocketInstance,
 *   user: { id: 'user-123', name: 'Alice', avatar_color: '#FF5733' },
 *   documentId: 'doc-456',
 *   canEdit: true,
 *   accessCheckedAt: Date.now(),
 *   lastActivity: Date.now(),
 * };
 */
export interface ClientConnection {
  ws: WebSocket;
  user: UserPublic;
  documentId: string | null;
  canEdit: boolean;
  accessCheckedAt: number;
  lastActivity: number;
}

/**
 * In-memory state for an active document being edited.
 * @description Contains the current version number, operation log for Operational
 * Transformation (OT), and a map of connected users' presence states.
 *
 * @interface DocumentState
 * @property {number} version - Current document version number, incremented with each operation
 * @property {Operation[][]} operationLog - Array of operation arrays for OT transformation history
 * @property {Map<string, PresenceState>} presence - Map of user IDs to their presence states (cursor, selection)
 *
 * @example
 * const docState: DocumentState = {
 *   version: 42,
 *   operationLog: [[{ type: 'insert', pos: 0, text: 'Hello' }]],
 *   presence: new Map([['user-123', { user_id: 'user-123', cursor: { pos: 5 } }]]),
 * };
 */
export interface DocumentState {
  version: number;
  operationLog: Operation[][];
  presence: Map<string, PresenceState>;
}

/**
 * Redis pub/sub message for cross-server operation broadcast.
 * @description Used to synchronize document operations across multiple server instances
 * in a distributed deployment. Each server publishes operations to Redis, and other
 * servers receive and apply them to their local clients.
 *
 * @interface RedisOperationMessage
 * @property {string} serverId - Unique identifier of the originating server (to filter self-messages)
 * @property {string} docId - UUID of the document the operation applies to
 * @property {number} version - Version number after the operation was applied
 * @property {Operation[]} operation - Array of operations to apply
 * @property {string} userId - ID of the user who performed the operation
 * @property {string} userName - Display name of the user (for UI attribution)
 *
 * @example
 * const message: RedisOperationMessage = {
 *   serverId: 'abc123',
 *   docId: 'doc-456',
 *   version: 43,
 *   operation: [{ type: 'insert', pos: 10, text: ' world' }],
 *   userId: 'user-123',
 *   userName: 'Alice',
 * };
 */
export interface RedisOperationMessage {
  serverId: string;
  docId: string;
  version: number;
  operation: Operation[];
  userId: string;
  userName: string;
}

/**
 * Redis pub/sub message for cross-server presence broadcast.
 * @description Used to synchronize user presence (cursor positions, selections)
 * across multiple server instances. Enables real-time visibility of where other
 * users are working in a document.
 *
 * @interface RedisPresenceMessage
 * @property {string} serverId - Unique identifier of the originating server (to filter self-messages)
 * @property {string} docId - UUID of the document the presence update applies to
 * @property {PresenceState} presence - The user's current presence state including cursor and selection
 *
 * @example
 * const message: RedisPresenceMessage = {
 *   serverId: 'abc123',
 *   docId: 'doc-456',
 *   presence: {
 *     user_id: 'user-123',
 *     name: 'Alice',
 *     color: '#FF5733',
 *     cursor: { pos: 25 },
 *     selection: null,
 *     last_active: Date.now(),
 *   },
 * };
 */
export interface RedisPresenceMessage {
  serverId: string;
  docId: string;
  presence: PresenceState;
}
