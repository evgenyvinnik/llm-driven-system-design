/**
 * @fileoverview Operational Transformation (OT) sync logic for collaborative editing.
 * @description Handles transforming operations against concurrent edits and broadcasting
 * updates to connected clients. This is the core conflict resolution mechanism.
 * @module services/collaboration/ot
 */

import type { WebSocket } from 'ws';
import type { ClientConnection } from './types.js';
import type { WSMessage, Operation } from '../../types/index.js';
import { transformOperations } from '../ot.js';
import _logger, { createChildLogger } from '../../shared/logger.js';
import {
  syncLatencyHistogram,
  operationsCounter,
  conflictsCounter,
} from '../../shared/metrics.js';
import { isCircuitOpen } from '../../shared/circuitBreaker.js';
import {
  getIdempotencyResult,
  setIdempotencyResult,
  generateOperationKey,
} from '../../shared/idempotency.js';
import { getDocumentAccess } from '../../shared/rbac.js';
import { documents, serverId, broadcastToDocument } from './state.js';
import { debouncedPersist, redisPublishCircuitBreaker } from './persist.js';
import { handleLeaveDocument } from './presence.js';
import { canEditDocument } from './permissions.js';

/**
 * How long a connection's edit right, read at SUBSCRIBE, is trusted before the
 * next OPERATION re-reads it. Bounds how long a downgrade (re-share as 'view')
 * or a deleted document goes unnoticed, on every server, without a DB query per keystroke.
 */
const ACCESS_RECHECK_MS = 5000;

/** Upper bounds on a single OPERATION message. */
const MAX_OPS_PER_MESSAGE = 1000;
const MAX_INSERT_LENGTH = 100_000;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Shape check for one client-supplied operation. Anything that is not a
 * well-formed insert/delete/retain/format is rejected rather than transformed,
 * logged, persisted and broadcast.
 *
 * @param {unknown} value - A candidate operation from an OPERATION message
 * @returns {boolean} True if the value is a valid Operation
 */
export function isValidOperation(value: unknown): value is Operation {
  if (!value || typeof value !== 'object') return false;
  const op = value as Record<string, unknown>;
  switch (op.type) {
    case 'insert':
      return (
        isCount(op.position) &&
        typeof op.text === 'string' &&
        op.text.length <= MAX_INSERT_LENGTH &&
        (op.attrs === undefined || (typeof op.attrs === 'object' && op.attrs !== null))
      );
    case 'delete':
      return isCount(op.position) && isCount(op.length);
    case 'retain':
      return isCount(op.length);
    case 'format':
      return (
        isCount(op.position) &&
        isCount(op.length) &&
        typeof op.mark === 'string' &&
        (typeof op.value === 'boolean' || typeof op.value === 'string')
      );
    default:
      return false;
  }
}

/**
 * Returns whether the client may still edit the document it sent an operation for.
 *
 * @description Trusts the right recorded at SUBSCRIBE for ACCESS_RECHECK_MS, then
 * re-reads it with the REST RBAC query (`getDocumentAccess`). A user who has lost
 * all access (document deleted) is removed from the document and told so.
 *
 * @param {WebSocket} ws - The client's connection
 * @param {ClientConnection} client - The client metadata
 * @param {string} documentId - The document the operation targets (the joined one)
 * @returns {Promise<boolean>} True if the user may edit documentId
 */
async function ensureCanEdit(
  ws: WebSocket,
  client: ClientConnection,
  documentId: string
): Promise<boolean> {
  if (Date.now() - client.accessCheckedAt < ACCESS_RECHECK_MS) {
    return client.canEdit;
  }

  const access = await getDocumentAccess(client.user.id, documentId);
  const canEdit = canEditDocument(access.isOwner, access.permissionLevel);

  // The client may have switched documents while we were querying.
  if (client.documentId !== documentId) return false;

  client.canEdit = canEdit;
  client.accessCheckedAt = Date.now();

  if (!access.effectiveRole) {
    handleLeaveDocument(ws, documentId);
    ws.send(JSON.stringify({ type: 'ERROR', code: 'ACCESS_DENIED', error: 'Access denied' }));
  }

  return canEdit;
}

/**
 * Handles an edit operation from a client.
 *
 * @description Processes incoming edit operations using Operational Transformation (OT).
 * Key steps:
 * 0. Refuses the operation unless it targets the subscribed document, the user
 *    may edit that document (owner or 'edit' grant), and every op is well formed
 * 1. Checks idempotency to prevent duplicate operations on retry
 * 2. Transforms the operation against any concurrent server operations the client hasn't seen
 * 3. Increments document version and stores operation in the log
 * 4. Sends ACK to the originating client with new version
 * 5. Broadcasts transformed operation to other clients
 * 6. Publishes to Redis for cross-server synchronization
 * 7. Triggers debounced database persistence
 *
 * @param {WebSocket} ws - The WebSocket connection of the client sending the operation
 * @param {ClientConnection} client - The client metadata including user info and current document
 * @param {WSMessage} msg - The WebSocket message containing the operation and version
 * @returns {Promise<void>} Resolves when operation processing is complete
 *
 * @example
 * // Handle an insert operation from client
 * const msg = {
 *   type: 'OPERATION',
 *   version: 42,
 *   operation: [{ type: 'insert', pos: 10, text: 'Hello' }],
 *   data: { operationId: 'op-abc123' },
 * };
 * await handleOperation(clientWebSocket, clientConnection, msg);
 */
export async function handleOperation(
  ws: WebSocket,
  client: ClientConnection,
  msg: WSMessage
): Promise<void> {
  const startTime = Date.now();
  const documentId = client.documentId;
  if (!documentId) {
    ws.send(JSON.stringify({ type: 'ERROR', code: 'NOT_SUBSCRIBED', error: 'Subscribe to a document first' }));
    return;
  }

  // An operation may only name the document this connection joined.
  if (msg.doc_id !== undefined && msg.doc_id !== documentId) {
    ws.send(JSON.stringify({ type: 'ERROR', code: 'DOC_MISMATCH', error: 'Operation is for a different document' }));
    return;
  }

  const opLogger = createChildLogger({
    userId: client.user.id,
    documentId,
    action: 'operation',
  });

  if (!(await ensureCanEdit(ws, client, documentId))) {
    if (client.documentId === documentId) {
      opLogger.warn('Operation refused: no edit permission');
      ws.send(JSON.stringify({ type: 'ERROR', code: 'READ_ONLY', error: 'Edit permission required' }));
    }
    return;
  }

  const operation: unknown = msg.operation;
  if (
    !Array.isArray(operation) ||
    operation.length === 0 ||
    operation.length > MAX_OPS_PER_MESSAGE ||
    !operation.every(isValidOperation) ||
    (msg.version !== undefined && !isCount(msg.version))
  ) {
    ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_OPERATION', error: 'Invalid operation' }));
    return;
  }

  const docState = documents.get(documentId);
  if (!docState) return;

  // Check idempotency if operation ID provided
  const operationId = (msg.data as { operationId?: string })?.operationId;
  if (operationId) {
    const idempotencyKey = generateOperationKey(client.user.id, documentId, operationId);
    const cachedResult = await getIdempotencyResult(idempotencyKey);

    if (cachedResult) {
      opLogger.debug({ operationId }, 'Duplicate operation detected (idempotency hit)');
      ws.send(JSON.stringify(cachedResult.result));
      return;
    }
  }

  const clientVersion = msg.version || 0;

  // Transform operation against any operations the client hasn't seen
  let transformedOps: Operation[] = operation;
  let hadConflicts = false;

  if (clientVersion < docState.version) {
    const missedOps = docState.operationLog.slice(clientVersion);
    for (const serverOps of missedOps) {
      transformedOps = transformOperations(transformedOps, serverOps);
    }
    hadConflicts = true;
    conflictsCounter.inc();
    opLogger.debug({
      clientVersion,
      serverVersion: docState.version,
      missedOps: missedOps.length,
    }, 'OT conflict resolved');
  }

  // Increment version and store operation
  docState.version++;
  docState.operationLog.push(transformedOps);

  // Track operation types for metrics
  for (const op of transformedOps) {
    operationsCounter.inc({ operation_type: op.type });
  }

  // Limit operation log size (keep last 1000 operations)
  if (docState.operationLog.length > 1000) {
    docState.operationLog = docState.operationLog.slice(-500);
  }

  // Prepare and send ACK
  const ackMessage = { type: 'ACK', version: docState.version };
  ws.send(JSON.stringify(ackMessage));

  // Store idempotency result if key provided
  if (operationId) {
    const idempotencyKey = generateOperationKey(client.user.id, documentId, operationId);
    await setIdempotencyResult(idempotencyKey, ackMessage);
  }

  // Record sync latency
  const latencyMs = Date.now() - startTime;
  syncLatencyHistogram.observe({ operation_type: transformedOps[0]?.type || 'unknown' }, latencyMs);

  opLogger.debug({
    version: docState.version,
    latencyMs,
    hadConflicts,
    operationCount: transformedOps.length,
  }, 'Operation processed');

  // Broadcast to other clients in document
  broadcastToDocument(documentId, {
    type: 'OPERATION',
    version: docState.version,
    operation: transformedOps,
    data: { userId: client.user.id, userName: client.user.name },
  }, ws);

  // Publish to Redis for other servers
  try {
    await redisPublishCircuitBreaker.fire('doc:operations', JSON.stringify({
      serverId,
      docId: documentId,
      version: docState.version,
      operation: transformedOps,
      userId: client.user.id,
      userName: client.user.name,
    }));
  } catch (error) {
    if (isCircuitOpen(error)) {
      opLogger.warn('Redis publish circuit open, operation not broadcast to other servers');
    } else {
      opLogger.error({ error }, 'Failed to publish operation to Redis');
    }
  }

  // Persist operation (debounced with circuit breaker)
  debouncedPersist(documentId, docState.version, transformedOps, client.user.id);
}
