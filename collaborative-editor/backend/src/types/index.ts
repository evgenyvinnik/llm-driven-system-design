// Operation types for OT-based collaborative editing

export interface RetainOp {
  retain: number;
}

export interface InsertOp {
  insert: string;
  attributes?: Record<string, unknown>;
}

export interface DeleteOp {
  delete: number;
}

export type Op = RetainOp | InsertOp | DeleteOp;

export interface OperationData {
  ops: Op[];
  baseLength: number;
  targetLength: number;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  color: string;
}

export interface Document {
  id: string;
  title: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentSnapshot {
  documentId: string;
  version: number;
  content: string;
  createdAt: Date;
}

export interface OperationRecord {
  id: string;
  documentId: string;
  version: number;
  clientId: string;
  userId: string;
  operation: OperationData;
  createdAt: Date;
}

export interface ClientInfo {
  clientId: string;
  userId: string;
  displayName: string;
  color: string;
  cursor: CursorPosition | null;
  selection: SelectionRange | null;
}

export interface CursorPosition {
  index: number;
  length?: number;
}

export interface SelectionRange {
  start: number;
  end: number;
}

// WebSocket message types
export type WSMessageType =
  | 'init'
  | 'operation'
  | 'ack'
  | 'cursor'
  | 'selection'
  | 'client_join'
  | 'client_leave'
  | 'resync'
  | 'error';

export interface WSMessage {
  type: WSMessageType;
  [key: string]: unknown;
}

export interface InitMessage extends WSMessage {
  type: 'init';
  clientId: string;
  version: number;
  content: string;
  clients: Array<[string, ClientInfo]>;
}

export interface OperationMessage extends WSMessage {
  type: 'operation';
  version: number;
  operation: OperationData;
  clientId?: string;
}

export interface AckMessage extends WSMessage {
  type: 'ack';
  version: number;
}

export interface CursorMessage extends WSMessage {
  type: 'cursor';
  position: CursorPosition;
  clientId?: string;
}

export interface SelectionMessage extends WSMessage {
  type: 'selection';
  selection: SelectionRange;
  clientId?: string;
}

export interface ClientJoinMessage extends WSMessage {
  type: 'client_join';
  clientId: string;
  userId: string;
  displayName: string;
  color: string;
}

export interface ClientLeaveMessage extends WSMessage {
  type: 'client_leave';
  clientId: string;
}

export interface ResyncMessage extends WSMessage {
  type: 'resync';
  version: number;
  content: string;
}

export interface ErrorMessage extends WSMessage {
  type: 'error';
  message: string;
}
