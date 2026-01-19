/**
 * @fileoverview Document synchronization operations for collaborative editing.
 * @description Handles subscribing to documents and syncing document state between
 * the server and connected clients. Manages the initial document load and join flow.
 * @module services/collaboration/sync
 */

import type { WebSocket } from 'ws';
import type { ClientConnection, DocumentState } from './types.js';
import _logger, { createChildLogger } from '../../shared/logger.js';
import { documents, updateDocumentsMetric } from './state.js';
import { handleLeaveDocument, addUserToDocument } from './presence.js';
import { checkDocumentPermission, hasAccess, getEffectivePermission } from './permissions.js';

/**
 * Initializes document state if not already cached.
 *
 * @description Creates a new DocumentState for a document if one doesn't exist
 * in the in-memory cache. Sets the initial version from the database and creates
 * empty operation log and presence map. Updates the active documents metric.
 *
 * @param {string} documentId - UUID of the document
 * @param {number} currentVersion - Current version number from the database
 * @returns {DocumentState} The document state (existing or newly created)
 *
 * @example
 * const docState = ensureDocumentState('doc-456', 42);
 * // docState is now guaranteed to exist in the documents map
 */
export function ensureDocumentState(documentId: string, currentVersion: number): DocumentState {
  if (!documents.has(documentId)) {
    documents.set(documentId, {
      version: currentVersion,
      operationLog: [],
      presence: new Map(),
    });
    updateDocumentsMetric();
  }
  return documents.get(documentId)!;
}

/**
 * Handles a client subscribing to a document for real-time updates.
 *
 * @description Processes a SUBSCRIBE message from a client. Performs the following steps:
 * 1. Verifies the document exists and user has access permission
 * 2. Leaves any previously subscribed document
 * 3. Initializes document state if not already cached
 * 4. Adds user to the document's presence map
 * 5. Sends SYNC message with current content, version, presence list, and permissions
 *
 * @param {WebSocket} ws - The WebSocket connection of the subscribing client
 * @param {ClientConnection} client - The client metadata including user info
 * @param {string} documentId - UUID of the document to subscribe to
 * @returns {Promise<void>} Resolves when subscription is complete
 *
 * @throws Sends ERROR message with code 'NOT_FOUND' if document doesn't exist
 * @throws Sends ERROR message with code 'ACCESS_DENIED' if user lacks permission
 *
 * @example
 * // Handle incoming subscribe message
 * ws.on('message', async (data) => {
 *   const msg = JSON.parse(data);
 *   if (msg.type === 'SUBSCRIBE') {
 *     await handleSubscribe(ws, client, msg.doc_id);
 *   }
 * });
 */
export async function handleSubscribe(
  ws: WebSocket,
  client: ClientConnection,
  documentId: string
): Promise<void> {
  const opLogger = createChildLogger({
    userId: client.user.id,
    documentId,
    action: 'subscribe',
  });

  // Check permission
  const permResult = await checkDocumentPermission(documentId, client.user.id);

  if (!permResult.found) {
    opLogger.warn('Subscribe failed: document not found');
    ws.send(JSON.stringify({ type: 'ERROR', code: 'NOT_FOUND', error: 'Document not found' }));
    return;
  }

  if (!hasAccess(client.user.id, permResult.ownerId!, permResult.permissionLevel || null)) {
    opLogger.warn('Subscribe failed: access denied');
    ws.send(JSON.stringify({ type: 'ERROR', code: 'ACCESS_DENIED', error: 'Access denied' }));
    return;
  }

  // Leave previous document if any
  if (client.documentId) {
    handleLeaveDocument(ws, client.documentId);
  }

  // Join new document
  client.documentId = documentId;

  // Initialize document state if not exists
  const docState = ensureDocumentState(documentId, permResult.currentVersion!);

  // Add user to presence
  const _presence = addUserToDocument(documentId, docState, client.user);

  opLogger.info({
    version: docState.version,
    activeUsers: docState.presence.size,
  }, 'User subscribed to document');

  // Send sync message with current document state
  ws.send(JSON.stringify({
    type: 'SYNC',
    doc_id: documentId,
    version: docState.version,
    data: {
      content: permResult.content,
      presence: Array.from(docState.presence.values()),
      permission_level: getEffectivePermission(
        client.user.id,
        permResult.ownerId!,
        permResult.permissionLevel || null
      ),
    },
  }));
}
