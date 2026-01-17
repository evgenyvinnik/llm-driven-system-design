import { TextOperation } from './TextOperation.js';
import { OTTransformer } from './OTTransformer.js';
import { db } from './database.js';
import { presence } from './redis.js';
import type { ClientInfo, CursorPosition, SelectionRange, OperationData } from '../types/index.js';

const SNAPSHOT_INTERVAL = 50; // Save snapshot every 50 operations

/**
 * DocumentState manages the in-memory state of an active document
 * and handles OT operations.
 */
export class DocumentState {
  documentId: string;
  version: number;
  content: string;
  clients: Map<string, ClientInfo>;
  private loading: boolean;
  private loadPromise: Promise<void> | null;

  constructor(documentId: string) {
    this.documentId = documentId;
    this.version = 0;
    this.content = '';
    this.clients = new Map();
    this.loading = false;
    this.loadPromise = null;
  }

  /**
   * Load the document state from the database
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
  }

  /**
   * Add a client to this document
   */
  async addClient(client: ClientInfo): Promise<void> {
    this.clients.set(client.clientId, client);
    await presence.addClient(this.documentId, client);
  }

  /**
   * Remove a client from this document
   */
  async removeClient(clientId: string): Promise<void> {
    this.clients.delete(clientId);
    await presence.removeClient(this.documentId, clientId);
  }

  /**
   * Update a client's cursor position
   */
  async updateCursor(clientId: string, cursor: CursorPosition): Promise<void> {
    const client = this.clients.get(clientId);
    if (client) {
      client.cursor = cursor;
      await presence.updateCursor(this.documentId, clientId, cursor);
    }
  }

  /**
   * Update a client's selection
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
   * Apply an operation from a client
   */
  async applyOperation(
    clientId: string,
    userId: string,
    clientVersion: number,
    operation: OperationData
  ): Promise<{ version: number; operation: OperationData }> {
    let transformedOp = TextOperation.fromJSON(operation);

    // Get all operations since the client's version
    const concurrentOps = await db.getOperationsSince(
      this.documentId,
      clientVersion
    );

    // Transform against all concurrent operations
    for (const opRecord of concurrentOps) {
      const serverOp = TextOperation.fromJSON(opRecord.operation);
      const [transformed] = OTTransformer.transform(transformedOp, serverOp);
      transformedOp = transformed;
    }

    // Apply the transformed operation
    try {
      this.content = transformedOp.apply(this.content);
    } catch (error) {
      console.error('Failed to apply operation:', error);
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

    // Periodically save snapshots
    if (this.version % SNAPSHOT_INTERVAL === 0) {
      await this.saveSnapshot();
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

    return {
      version: this.version,
      operation: transformedOp.toJSON(),
    };
  }

  /**
   * Save a snapshot of the current document state
   */
  async saveSnapshot(): Promise<void> {
    await db.saveSnapshot(this.documentId, this.version, this.content);
  }

  /**
   * Get the current document state for a new client
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
