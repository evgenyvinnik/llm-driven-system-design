/**
 * @fileoverview User presence tracking for collaborative editing.
 * @description Manages online users, broadcasts presence updates, and handles users
 * joining/leaving documents. Provides real-time visibility of who is viewing a document.
 * @module services/collaboration/presence
 */

import type { WebSocket } from 'ws';
import type { ClientConnection, DocumentState } from './types.js';
import type { PresenceState } from '../../types/index.js';
import { redisPub } from '../../utils/redis.js';
import logger from '../../shared/logger.js';
import { documents, clients, serverId, broadcastToDocument, updateDocumentsMetric } from './state.js';

/**
 * Creates a presence state object for a user joining a document.
 *
 * @description Initializes a new presence state with the user's identity info
 * and default cursor/selection values. The presence state is used to track
 * where users are in the document and display their cursors to others.
 *
 * @param {ClientConnection['user']} user - The user's public profile data
 * @returns {PresenceState} A new presence state object with null cursor/selection
 *
 * @example
 * const user = { id: 'user-123', name: 'Alice', avatar_color: '#FF5733' };
 * const presence = createPresenceState(user);
 * // Returns: { user_id: 'user-123', name: 'Alice', color: '#FF5733', cursor: null, selection: null, last_active: 1704067200000 }
 */
export function createPresenceState(user: ClientConnection['user']): PresenceState {
  return {
    user_id: user.id,
    name: user.name,
    color: user.avatar_color,
    cursor: null,
    selection: null,
    last_active: Date.now(),
  };
}

/**
 * Adds a user to a document's presence map and broadcasts their arrival.
 *
 * @description Creates a presence state for the user, adds them to the document's
 * presence map, and broadcasts a presence update to all other users in the document.
 * This notifies other collaborators that a new user has joined.
 *
 * @param {string} documentId - UUID of the document being joined
 * @param {DocumentState} docState - The in-memory state of the document
 * @param {ClientConnection['user']} user - The user's public profile data
 * @returns {PresenceState} The created presence state for the user
 *
 * @example
 * const docState = documents.get('doc-456');
 * const user = { id: 'user-123', name: 'Alice', avatar_color: '#FF5733' };
 * const presence = addUserToDocument('doc-456', docState, user);
 */
export function addUserToDocument(
  documentId: string,
  docState: DocumentState,
  user: ClientConnection['user']
): PresenceState {
  const presence = createPresenceState(user);
  docState.presence.set(user.id, presence);
  broadcastPresence(documentId, presence);
  return presence;
}

/**
 * Handles a client leaving/unsubscribing from a document.
 *
 * @description Removes the user's presence from the document state, broadcasts their
 * departure to remaining users, and cleans up empty document states to free memory.
 * Called when a user unsubscribes from a document or disconnects.
 *
 * @param {WebSocket} ws - The WebSocket connection of the departing client
 * @param {string} documentId - UUID of the document being left
 * @returns {void}
 *
 * @example
 * // When user clicks "Close" or navigates away
 * handleLeaveDocument(clientWebSocket, 'doc-456');
 */
export function handleLeaveDocument(ws: WebSocket, documentId: string): void {
  const client = clients.get(ws);
  if (!client) return;

  const docState = documents.get(documentId);
  if (docState) {
    docState.presence.delete(client.user.id);

    logger.debug({
      userId: client.user.id,
      documentId,
      remainingUsers: docState.presence.size,
    }, 'User left document');

    // Broadcast user left
    broadcastToDocument(documentId, {
      type: 'PRESENCE',
      data: {
        user_id: client.user.id,
        left: true,
      },
    }, ws);

    // Clean up empty document states
    if (docState.presence.size === 0) {
      documents.delete(documentId);
      updateDocumentsMetric();
    }
  }

  client.documentId = null;
  client.canEdit = false;
}

/**
 * Broadcasts a presence update to all clients in a document.
 *
 * @description Sends the presence update to all local clients connected to the document
 * and publishes to Redis for cross-server notification. This ensures all users across
 * all server instances see the presence update.
 *
 * @param {string} documentId - UUID of the document
 * @param {PresenceState} presence - The presence state to broadcast
 * @returns {void}
 *
 * @example
 * const presence = { user_id: 'user-123', name: 'Alice', cursor: { pos: 42 } };
 * broadcastPresence('doc-456', presence);
 */
export function broadcastPresence(documentId: string, presence: PresenceState): void {
  broadcastToDocument(documentId, {
    type: 'PRESENCE',
    data: presence,
  }, null);

  redisPub.publish('doc:presence', JSON.stringify({
    serverId,
    docId: documentId,
    presence,
  })).catch((error) => {
    logger.trace({ error, documentId }, 'Failed to publish presence to Redis');
  });
}

/**
 * Returns the current list of online users for a document.
 *
 * @description Retrieves all presence states for users currently viewing the specified
 * document. Used for displaying presence indicators and user lists in the UI.
 *
 * @param {string} documentId - UUID of the document
 * @returns {PresenceState[]} Array of presence states for all online users, or empty array if document not found
 *
 * @example
 * const onlineUsers = getDocumentPresence('doc-456');
 * console.log(`${onlineUsers.length} users online`);
 * // Display cursors for each user
 * onlineUsers.forEach(p => renderCursor(p.cursor, p.color));
 */
export function getDocumentPresence(documentId: string): PresenceState[] {
  const docState = documents.get(documentId);
  if (!docState) return [];
  return Array.from(docState.presence.values());
}
