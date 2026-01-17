import { create } from 'zustand';
import { TextOperation } from '../services/TextOperation';
import { OTTransformer } from '../services/OTTransformer';
import type {
  ClientInfo,
  CursorPosition,
  OperationData,
  WSMessage,
  InitMessage,
  OperationMessage,
  AckMessage,
  CursorMessage,
  SelectionMessage,
  ClientJoinMessage,
  ClientLeaveMessage,
  ResyncMessage,
} from '../types';

/**
 * Editor state interface for the Zustand store.
 *
 * Manages all state related to the collaborative editing session:
 * - WebSocket connection state
 * - Document content and version
 * - Pending operations (for optimistic updates)
 * - Presence information (other connected clients)
 */
interface EditorState {
  // ============================================================================
  // Connection State
  // ============================================================================

  /** Whether the WebSocket is connected */
  connected: boolean;
  /** Current document ID being edited */
  documentId: string | null;
  /** Current user's ID */
  userId: string | null;
  /** Unique client session ID assigned by the server */
  clientId: string | null;

  // ============================================================================
  // Document State
  // ============================================================================

  /** Current document content (includes optimistic local changes) */
  content: string;
  /** Last acknowledged server version */
  serverVersion: number;

  // ============================================================================
  // Pending Operations (OT Client State Machine)
  // ============================================================================

  /** Operation sent to server, awaiting acknowledgment */
  inflightOp: TextOperation | null;
  /** Operations applied locally but not yet sent to server */
  pendingOps: TextOperation[];

  // ============================================================================
  // Presence
  // ============================================================================

  /** Map of connected clients by client ID */
  clients: Map<string, ClientInfo>;

  // ============================================================================
  // WebSocket
  // ============================================================================

  /** The WebSocket connection (null if disconnected) */
  ws: WebSocket | null;

  // ============================================================================
  // Actions
  // ============================================================================

  /**
   * Connect to a document via WebSocket.
   * @param documentId - The document to edit
   * @param userId - The authenticated user's ID
   */
  connect: (documentId: string, userId: string) => void;

  /**
   * Disconnect from the current document.
   * Closes the WebSocket and resets all state.
   */
  disconnect: () => void;

  /**
   * Apply a local edit to the document.
   * The operation is applied optimistically and queued for sync.
   * @param operation - The text operation to apply
   */
  applyLocalChange: (operation: TextOperation) => void;

  /**
   * Send a cursor position update to other clients.
   * @param position - The new cursor position
   */
  updateCursor: (position: CursorPosition) => void;

  /**
   * Update the local content (used for syncing with textarea).
   * @param content - The new content
   */
  setContent: (content: string) => void;
}

/**
 * Zustand store for collaborative editor state.
 *
 * Implements the OT client state machine:
 * 1. Local edits are applied optimistically and added to pendingOps
 * 2. When no operation is in-flight, pending ops are composed and sent
 * 3. When an ack arrives, the in-flight op is cleared and more may be sent
 * 4. When a remote op arrives, it's transformed against in-flight and pending ops
 */
export const useEditorStore = create<EditorState>((set, get) => ({
  connected: false,
  documentId: null,
  userId: null,
  clientId: null,
  content: '',
  serverVersion: 0,
  inflightOp: null,
  pendingOps: [],
  clients: new Map(),
  ws: null,

  connect: (documentId: string, userId: string) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?documentId=${documentId}&userId=${userId}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
      const message: WSMessage = JSON.parse(event.data);
      handleMessage(message, set, get);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      set({ connected: false, ws: null });
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    set({ documentId, userId, ws });
  },

  disconnect: () => {
    const { ws } = get();
    if (ws) {
      ws.close();
    }
    set({
      connected: false,
      documentId: null,
      clientId: null,
      ws: null,
      content: '',
      serverVersion: 0,
      inflightOp: null,
      pendingOps: [],
      clients: new Map(),
    });
  },

  applyLocalChange: (operation: TextOperation) => {
    const { pendingOps, ws, serverVersion, inflightOp } = get();

    // Apply locally
    const newContent = operation.apply(get().content);

    // Add to pending
    const newPending = [...pendingOps, operation];
    set({ content: newContent, pendingOps: newPending });

    // Try to flush
    if (!inflightOp && ws && ws.readyState === WebSocket.OPEN) {
      flushPending(set, get);
    }
  },

  updateCursor: (position: CursorPosition) => {
    const { ws } = get();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cursor', position }));
    }
  },

  setContent: (content: string) => {
    set({ content });
  },
}));

/**
 * Route incoming WebSocket messages to appropriate handlers.
 *
 * @param message - The parsed WebSocket message
 * @param set - Zustand set function
 * @param get - Zustand get function
 */
function handleMessage(
  message: WSMessage,
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState
) {
  switch (message.type) {
    case 'init':
      handleInit(message as InitMessage, set);
      break;
    case 'ack':
      handleAck(message as AckMessage, set, get);
      break;
    case 'operation':
      handleRemoteOperation(message as OperationMessage, set, get);
      break;
    case 'cursor':
      handleCursor(message as CursorMessage, set, get);
      break;
    case 'selection':
      handleSelection(message as SelectionMessage, set, get);
      break;
    case 'client_join':
      handleClientJoin(message as ClientJoinMessage, set, get);
      break;
    case 'client_leave':
      handleClientLeave(message as ClientLeaveMessage, set, get);
      break;
    case 'resync':
      handleResync(message as ResyncMessage, set);
      break;
    case 'error':
      console.error('Server error:', message.message);
      break;
  }
}

/**
 * Handle the initial state message from the server.
 * Sets up the document content, version, and initial client list.
 *
 * @param message - The init message with document state
 * @param set - Zustand set function
 */
function handleInit(message: InitMessage, set: (partial: Partial<EditorState>) => void) {
  const clients = new Map<string, ClientInfo>();
  for (const [clientId, clientInfo] of message.clients) {
    clients.set(clientId, clientInfo);
  }

  set({
    connected: true,
    clientId: message.clientId,
    serverVersion: message.version,
    content: message.content,
    clients,
    inflightOp: null,
    pendingOps: [],
  });
}

/**
 * Handle acknowledgment of a sent operation.
 * Clears the in-flight operation and attempts to send more pending ops.
 *
 * @param message - The ack message with assigned version
 * @param set - Zustand set function
 * @param get - Zustand get function
 */
function handleAck(
  message: AckMessage,
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState
) {
  set({
    serverVersion: message.version,
    inflightOp: null,
  });

  // Try to flush more pending ops
  flushPending(set, get);
}

/**
 * Handle a remote operation from another client.
 *
 * Transforms the incoming operation against any in-flight and pending
 * local operations to maintain consistency. The transformed operation
 * is then applied to the local content.
 *
 * @param message - The operation message from the server
 * @param set - Zustand set function
 * @param get - Zustand get function
 */
function handleRemoteOperation(
  message: OperationMessage,
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState
) {
  let op = TextOperation.fromJSON(message.operation);
  const { inflightOp, pendingOps, content, clientId } = get();

  // Skip our own operations (they're already applied)
  if (message.clientId === clientId) {
    set({ serverVersion: message.version });
    return;
  }

  let newInflightOp = inflightOp;
  const newPendingOps: TextOperation[] = [];

  // Transform against inflight operation
  if (inflightOp) {
    const [opPrime, inflightPrime] = OTTransformer.transform(op, inflightOp);
    op = opPrime;
    newInflightOp = inflightPrime;
  }

  // Transform against pending operations
  for (const pending of pendingOps) {
    const [opPrime, pendingPrime] = OTTransformer.transform(op, pending);
    op = opPrime;
    newPendingOps.push(pendingPrime);
  }

  // Apply to content
  const newContent = op.apply(content);

  set({
    serverVersion: message.version,
    content: newContent,
    inflightOp: newInflightOp,
    pendingOps: newPendingOps,
  });
}

/**
 * Handle a cursor position update from another client.
 *
 * @param message - The cursor message
 * @param set - Zustand set function
 * @param get - Zustand get function
 */
function handleCursor(
  message: CursorMessage,
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState
) {
  const { clients, clientId } = get();
  if (message.clientId === clientId) return;

  const client = clients.get(message.clientId!);
  if (client) {
    const newClients = new Map(clients);
    newClients.set(message.clientId!, {
      ...client,
      cursor: message.position,
    });
    set({ clients: newClients });
  }
}

/**
 * Handle a selection update from another client.
 *
 * @param message - The selection message
 * @param set - Zustand set function
 * @param get - Zustand get function
 */
function handleSelection(
  message: SelectionMessage,
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState
) {
  const { clients, clientId } = get();
  if (message.clientId === clientId) return;

  const client = clients.get(message.clientId!);
  if (client) {
    const newClients = new Map(clients);
    newClients.set(message.clientId!, {
      ...client,
      selection: message.selection,
    });
    set({ clients: newClients });
  }
}

/**
 * Handle a new client joining the document.
 * Adds the client to the presence list.
 *
 * @param message - The client join message
 * @param set - Zustand set function
 * @param get - Zustand get function
 */
function handleClientJoin(
  message: ClientJoinMessage,
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState
) {
  const { clients } = get();
  const newClients = new Map(clients);
  newClients.set(message.clientId, {
    clientId: message.clientId,
    userId: message.userId,
    displayName: message.displayName,
    color: message.color,
    cursor: null,
    selection: null,
  });
  set({ clients: newClients });
}

/**
 * Handle a client leaving the document.
 * Removes the client from the presence list.
 *
 * @param message - The client leave message
 * @param set - Zustand set function
 * @param get - Zustand get function
 */
function handleClientLeave(
  message: ClientLeaveMessage,
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState
) {
  const { clients } = get();
  const newClients = new Map(clients);
  newClients.delete(message.clientId);
  set({ clients: newClients });
}

/**
 * Handle a resync message from the server.
 * Replaces local state with server state when OT fails.
 *
 * @param message - The resync message with full document state
 * @param set - Zustand set function
 */
function handleResync(
  message: ResyncMessage,
  set: (partial: Partial<EditorState>) => void
) {
  set({
    serverVersion: message.version,
    content: message.content,
    inflightOp: null,
    pendingOps: [],
  });
}

/**
 * Flush pending operations to the server.
 *
 * Composes all pending operations into a single operation and sends
 * it to the server. Only sends if there's no operation currently
 * in-flight (waiting for acknowledgment).
 *
 * @param set - Zustand set function
 * @param get - Zustand get function
 */
function flushPending(
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState
) {
  const { inflightOp, pendingOps, ws, serverVersion } = get();

  if (inflightOp || pendingOps.length === 0 || !ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  // Compose all pending into one
  let op = pendingOps[0];
  for (let i = 1; i < pendingOps.length; i++) {
    op = OTTransformer.compose(op, pendingOps[i]);
  }

  // Send to server
  ws.send(JSON.stringify({
    type: 'operation',
    version: serverVersion,
    operation: op.toJSON(),
  }));

  set({
    inflightOp: op,
    pendingOps: [],
  });
}
