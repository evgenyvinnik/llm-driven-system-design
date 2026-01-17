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

interface EditorState {
  // Connection state
  connected: boolean;
  documentId: string | null;
  userId: string | null;
  clientId: string | null;

  // Document state
  content: string;
  serverVersion: number;

  // Pending operations
  inflightOp: TextOperation | null;
  pendingOps: TextOperation[];

  // Presence
  clients: Map<string, ClientInfo>;

  // WebSocket
  ws: WebSocket | null;

  // Actions
  connect: (documentId: string, userId: string) => void;
  disconnect: () => void;
  applyLocalChange: (operation: TextOperation) => void;
  updateCursor: (position: CursorPosition) => void;
  setContent: (content: string) => void;
}

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
