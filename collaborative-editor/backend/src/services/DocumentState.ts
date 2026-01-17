import { TextOperation } from './TextOperation.js';
import { OTTransformer } from './OTTransformer.js';
import { db } from './database.js';
import { presence } from './redis.js';
import type { ClientInfo, CursorPosition, SelectionRange, OperationData } from '../types/index.js';
import {
  logger,
  logOperation,
  logConflict,
  logError,
  transformLatency,
  getServerId,
  queueSnapshot,
} from '../shared/index.js';

/**
 * Interval for saving document snapshots (in number of operations).
 * Snapshots are taken every N operations to enable efficient document loading.
 */
const SNAPSHOT_INTERVAL = 50;

/**
 * Server ID for metrics labeling.
 */
const SERVER_ID = getServerId();

/**
 * DocumentState manages the in-memory state of an active document
 * and handles OT operations.
 *
 * This class is the core of the collaborative editing server. It:
 * - Maintains the current document content and version in memory
 * - Tracks connected clients and their cursor positions
 * - Applies incoming operations using OT transformation
 * - Persists operations to the database
 * - Periodically saves snapshots for efficient loading
 * - Logs conflict resolution for debugging
 *
 * One instance is created per active document (documents with connected clients).
 * When the last client disconnects, the state is persisted and unloaded.
 */
export class DocumentState {
  /** The document's UUID */
  documentId: string;
  /** Current server version number (monotonically increasing) */
  version: number;
  /** Current document content */
  content: string;
  /** Map of connected clients by client ID */
  clients: Map<string, ClientInfo>;
  /** Whether the document is currently loading from the database */
  private loading: boolean;
  /** Promise for the loading operation (for deduplication) */
  private loadPromise: Promise<void> | null;

  /**
   * Create a new DocumentState instance.
   * Call load() after construction to initialize from the database.
   *
   * @param documentId - The document's UUID
   */
  constructor(documentId: string) {
    this.documentId = documentId;
    this.version = 0;
    this.content = '';
    this.clients = new Map();
    this.loading = false;
    this.loadPromise = null;
  }

  /**
   * Load the document state from the database.
   *
   * Loads the latest snapshot and replays any operations since that snapshot.
   * Also loads the current presence list from Redis.
   * Safe to call multiple times; subsequent calls wait for the first load.
   */
  async load(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loading = true;
    this.loadPromise = this._load();
    await this.loadPromise;
    this.loading = false;
  }

  private async _load(): Promise<void> {
    // Load latest snapshot
    const snapshot = await db.getLatestSnapshot(this.documentId);

    if (snapshot) {
      this.version = snapshot.version;
      this.content = snapshot.content;
    }

    // Apply any operations after the snapshot
    const ops = await db.getOperationsSince(this.documentId, this.version);

    for (const opRecord of ops) {
      const op = TextOperation.fromJSON(opRecord.operation);
      this.content = op.apply(this.content);
      this.version = opRecord.version;
    }

    // Load presence from Redis
    this.clients = await presence.getClients(this.documentId);

    logger.info({
      event: 'document_loaded',
      document_id: this.documentId,
      version: this.version,
      content_length: this.content.length,
      client_count: this.clients.size,
    });
  }

  /**
   * Add a client to this document.
   * Updates both in-memory state and Redis presence.
   *
   * @param client - The client information to add
   */
  async addClient(client: ClientInfo): Promise<void> {
    this.clients.set(client.clientId, client);
    await presence.addClient(this.documentId, client);
  }

  /**
   * Remove a client from this document.
   * Updates both in-memory state and Redis presence.
   *
   * @param clientId - The client's session ID to remove
   */
  async removeClient(clientId: string): Promise<void> {
    this.clients.delete(clientId);
    await presence.removeClient(this.documentId, clientId);
  }

  /**
   * Update a client's cursor position.
   * Updates both in-memory state and Redis presence.
   *
   * @param clientId - The client's session ID
   * @param cursor - The new cursor position
   */
  async updateCursor(clientId: string, cursor: CursorPosition): Promise<void> {
    const client = this.clients.get(clientId);
    if (client) {
      client.cursor = cursor;
      await presence.updateCursor(this.documentId, clientId, cursor);
    }
  }

  /**
   * Update a client's text selection.
   * Updates both in-memory state and Redis presence.
   *
   * @param clientId - The client's session ID
   * @param selection - The new selection range, or null to clear
   */
  async updateSelection(
    clientId: string,
    selection: SelectionRange | null
  ): Promise<void> {
    const client = this.clients.get(clientId);
    if (client) {
      client.selection = selection;
      await presence.updateSelection(this.documentId, clientId, selection);
    }
  }

  /**
   * Apply an operation from a client.
   *
   * This is the core OT logic. The operation is transformed against any
   * concurrent operations that happened since the client's known version,
   * then applied to the document and persisted.
   *
   * Also updates all other clients' cursor positions to account for
   * the text changes.
   *
   * Logs conflict resolution details when transformations are needed.
   *
   * @param clientId - The ID of the client sending the operation
   * @param userId - The ID of the user who made the change
   * @param clientVersion - The server version the client's operation was based on
   * @param operation - The operation data from the client
   * @returns The new version and the transformed operation
   * @throws Error if the operation cannot be applied
   */
  async applyOperation(
    clientId: string,
    userId: string,
    clientVersion: number,
    operation: OperationData
  ): Promise<{ version: number; operation: OperationData }> {
    const startTime = Date.now();
    let transformedOp = TextOperation.fromJSON(operation);
    const originalOp = transformedOp.toJSON();

    // Get all operations since the client's version
    const concurrentOps = await db.getOperationsSince(
      this.documentId,
      clientVersion
    );

    // Transform against all concurrent operations
    const transformStart = Date.now();
    for (const opRecord of concurrentOps) {
      const serverOp = TextOperation.fromJSON(opRecord.operation);
      const [transformed] = OTTransformer.transform(transformedOp, serverOp);
      transformedOp = transformed;
    }
    const transformTime = Date.now() - transformStart;

    // Record transform latency with concurrent ops bucket
    const concurrentBucket = concurrentOps.length === 0 ? '0' :
      concurrentOps.length <= 5 ? '1-5' :
      concurrentOps.length <= 10 ? '6-10' : '10+';
    transformLatency.observe(
      { server_id: SERVER_ID, concurrent_ops: concurrentBucket },
      transformTime
    );

    // Log conflict resolution if transformations were needed
    if (concurrentOps.length > 0) {
      logConflict(this.documentId, clientId, {
        clientVersion,
        serverVersion: this.version,
        concurrentOpCount: concurrentOps.length,
        transformedOp: transformedOp.toJSON(),
        originalOp,
      });
    }

    // Apply the transformed operation
    try {
      this.content = transformedOp.apply(this.content);
    } catch (error) {
      logError('operation_apply', error as Error);
      logger.error({
        event: 'operation_apply_failed',
        document_id: this.documentId,
        client_id: clientId,
        client_version: clientVersion,
        server_version: this.version,
        base_length: transformedOp.baseLength,
        content_length: this.content.length,
      });
      throw error;
    }

    this.version++;

    // Persist the operation
    await db.saveOperation(
      this.documentId,
      this.version,
      clientId,
      userId,
      transformedOp.toJSON()
    );

    // Queue snapshot asynchronously if needed
    if (this.version % SNAPSHOT_INTERVAL === 0) {
      try {
        await queueSnapshot(this.documentId, this.version, this.content);
      } catch (error) {
        // Fall back to synchronous snapshot if queue fails
        logger.warn({
          event: 'snapshot_queue_failed',
          document_id: this.documentId,
          error: (error as Error).message,
        });
        await this.saveSnapshot();
      }
    }

    // Transform all client cursors
    for (const [cid, client] of this.clients) {
      if (client.cursor && cid !== clientId) {
        const isOwnCursor = cid === clientId;
        client.cursor.index = OTTransformer.transformCursor(
          client.cursor.index,
          transformedOp,
          isOwnCursor
        );
        await presence.updateCursor(this.documentId, cid, client.cursor);
      }
    }

    const totalTime = Date.now() - startTime;

    // Log the operation
    logOperation(this.documentId, clientId, transformedOp.toJSON(), {
      version: this.version,
      transformCount: concurrentOps.length,
      latencyMs: totalTime,
    });

    return {
      version: this.version,
      operation: transformedOp.toJSON(),
    };
  }

  /**
   * Save a snapshot of the current document state.
   * Snapshots enable efficient document loading by avoiding full replay.
   */
  async saveSnapshot(): Promise<void> {
    try {
      await db.saveSnapshot(this.documentId, this.version, this.content);
      logger.info({
        event: 'snapshot_saved',
        document_id: this.documentId,
        version: this.version,
        content_length: this.content.length,
      });
    } catch (error) {
      logError('snapshot_save', error as Error);
    }
  }

  /**
   * Get the current document state for a new client.
   * Returns everything needed to initialize a client's editor.
   *
   * @returns Object containing version, content, and connected clients
   */
  getInitState(): {
    version: number;
    content: string;
    clients: Array<[string, ClientInfo]>;
  } {
    return {
      version: this.version,
      content: this.content,
      clients: Array.from(this.clients.entries()),
    };
  }
}
