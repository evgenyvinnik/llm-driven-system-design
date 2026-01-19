/**
 * Shared types and interfaces for WebSocket collaboration.
 *
 * @description This module defines all TypeScript interfaces and types used across
 * the WebSocket collaboration system. It includes connection types, message payloads,
 * and shared constants for real-time spreadsheet editing.
 *
 * @module websocket/types
 */

import { WebSocket } from 'ws';

/**
 * Extended WebSocket interface with user and session properties.
 *
 * @description Extends the base WebSocket interface to track user identity,
 * session information, and spreadsheet association for each connection.
 * Used throughout the WebSocket handlers to identify users and their context.
 *
 * @property {string} [userId] - Unique identifier for the connected user
 * @property {string} [sessionId] - Session identifier for reconnection handling
 * @property {string} [spreadsheetId] - ID of the spreadsheet the user is editing
 * @property {string} [userName] - Display name for presence indicators
 * @property {string} [userColor] - Hex color code for cursor/selection highlighting
 * @property {boolean} [isAlive] - Heartbeat flag for stale connection detection
 *
 * @example
 * ```typescript
 * const ws = socket as ExtendedWebSocket;
 * ws.userId = 'user-123';
 * ws.spreadsheetId = 'spreadsheet-456';
 * ws.userColor = '#FF6B6B';
 * ```
 */
export interface ExtendedWebSocket extends WebSocket {
  userId?: string;
  sessionId?: string;
  spreadsheetId?: string;
  userName?: string;
  userColor?: string;
  isAlive?: boolean;
}

/**
 * Represents a collaborative editing room for a single spreadsheet.
 *
 * @description A room is created for each spreadsheet being actively edited.
 * Multiple users can join the same room to collaborate in real-time.
 * All members of a room receive broadcasts of changes made by other members.
 *
 * @property {Set<ExtendedWebSocket>} clients - Set of all connected WebSocket clients in this room
 *
 * @example
 * ```typescript
 * const room: Room = { clients: new Set() };
 * room.clients.add(ws);
 * console.log(`Room has ${room.clients.size} collaborators`);
 * ```
 */
export interface Room {
  clients: Set<ExtendedWebSocket>;
}

/**
 * Cell data structure for storage and transmission.
 *
 * @description Represents the complete state of a spreadsheet cell,
 * including both the user-entered value and the computed result.
 * Used for database storage, caching, and WebSocket message payloads.
 *
 * @property {string} rawValue - The original value entered by the user (may be a formula)
 * @property {string} computedValue - The computed result after formula evaluation
 * @property {any} [format] - Optional cell formatting options (font, color, borders, etc.)
 *
 * @example
 * ```typescript
 * const cell: CellData = {
 *   rawValue: '=SUM(A1:A10)',
 *   computedValue: '150',
 *   format: { bold: true, backgroundColor: '#FFFF00' }
 * };
 * ```
 */
export interface CellData {
  rawValue: string;
  computedValue: string;
  format?: any;
}

/**
 * Collaborator presence information.
 *
 * @description Represents the visible identity of a user for presence awareness.
 * Sent to other users when someone joins, moves their cursor, or changes selection.
 *
 * @property {string} [userId] - Unique identifier for the collaborator
 * @property {string} [name] - Display name shown in presence indicators
 * @property {string} [color] - Hex color code for visual differentiation
 *
 * @example
 * ```typescript
 * const collaborator: Collaborator = {
 *   userId: 'user-123',
 *   name: 'Alice',
 *   color: '#4ECDC4'
 * };
 * ```
 */
export interface Collaborator {
  userId?: string;
  name?: string;
  color?: string;
}

/**
 * Cell edit payload from client.
 *
 * @description Message payload sent when a user edits a cell value.
 * Includes the cell location, new value, and optional request ID for idempotency.
 *
 * @property {string} sheetId - UUID of the sheet containing the cell
 * @property {number} row - Zero-based row index of the cell
 * @property {number} col - Zero-based column index of the cell
 * @property {string} value - The new cell value (may be text, number, or formula)
 * @property {string} [requestId] - Optional client-generated ID for idempotent retries
 *
 * @example
 * ```typescript
 * const payload: CellEditPayload = {
 *   sheetId: 'sheet-abc',
 *   row: 5,
 *   col: 2,
 *   value: '=A1+B1',
 *   requestId: 'req-123'
 * };
 * ```
 */
export interface CellEditPayload {
  sheetId: string;
  row: number;
  col: number;
  value: string;
  requestId?: string;
}

/**
 * Cursor move payload from client.
 *
 * @description Message payload sent when a user moves their cursor to a different cell.
 * Used to broadcast cursor positions to other collaborators.
 *
 * @property {number} row - Zero-based row index of the cursor position
 * @property {number} col - Zero-based column index of the cursor position
 *
 * @example
 * ```typescript
 * const payload: CursorMovePayload = { row: 10, col: 3 };
 * ```
 */
export interface CursorMovePayload {
  row: number;
  col: number;
}

/**
 * Selection change payload from client.
 *
 * @description Message payload sent when a user changes their cell selection range.
 * Supports both single-cell and multi-cell range selections.
 *
 * @property {object} range - The selected range coordinates
 * @property {number} range.startRow - Starting row of the selection (inclusive)
 * @property {number} range.startCol - Starting column of the selection (inclusive)
 * @property {number} range.endRow - Ending row of the selection (inclusive)
 * @property {number} range.endCol - Ending column of the selection (inclusive)
 *
 * @example
 * ```typescript
 * const payload: SelectionChangePayload = {
 *   range: { startRow: 0, startCol: 0, endRow: 5, endCol: 3 }
 * };
 * ```
 */
export interface SelectionChangePayload {
  range: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  };
}

/**
 * Column resize payload from client.
 *
 * @description Message payload sent when a user resizes a column.
 * The new width is persisted and broadcast to all collaborators.
 *
 * @property {string} sheetId - UUID of the sheet containing the column
 * @property {number} col - Zero-based column index being resized
 * @property {number} width - New width in pixels
 *
 * @example
 * ```typescript
 * const payload: ResizeColumnPayload = {
 *   sheetId: 'sheet-abc',
 *   col: 2,
 *   width: 150
 * };
 * ```
 */
export interface ResizeColumnPayload {
  sheetId: string;
  col: number;
  width: number;
}

/**
 * Row resize payload from client.
 *
 * @description Message payload sent when a user resizes a row.
 * The new height is persisted and broadcast to all collaborators.
 *
 * @property {string} sheetId - UUID of the sheet containing the row
 * @property {number} row - Zero-based row index being resized
 * @property {number} height - New height in pixels
 *
 * @example
 * ```typescript
 * const payload: ResizeRowPayload = {
 *   sheetId: 'sheet-abc',
 *   row: 5,
 *   height: 40
 * };
 * ```
 */
export interface ResizeRowPayload {
  sheetId: string;
  row: number;
  height: number;
}

/**
 * Sheet rename payload from client.
 *
 * @description Message payload sent when a user renames a sheet tab.
 * The new name is persisted and broadcast to all collaborators.
 *
 * @property {string} sheetId - UUID of the sheet being renamed
 * @property {string} name - New display name for the sheet tab
 *
 * @example
 * ```typescript
 * const payload: RenameSheetPayload = {
 *   sheetId: 'sheet-abc',
 *   name: 'Q4 Budget'
 * };
 * ```
 */
export interface RenameSheetPayload {
  sheetId: string;
  name: string;
}

/**
 * Predefined color palette for collaborator presence indicators.
 *
 * @description An array of visually distinct hex color codes used to assign
 * colors to collaborators. Colors cycle through the array as new users join,
 * ensuring each collaborator has a unique visual identifier for their cursor
 * and selection highlights.
 *
 * @constant {string[]}
 *
 * @example
 * ```typescript
 * const userColor = COLORS[colorIndex % COLORS.length];
 * colorIndex++;
 * ```
 */
export const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#74B9FF', '#A29BFE', '#FD79A8', '#00B894'
];
