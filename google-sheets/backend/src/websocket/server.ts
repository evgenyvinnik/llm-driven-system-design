/**
 * WebSocket server for real-time spreadsheet collaboration.
 * Handles connection lifecycle, message routing, room management,
 * and broadcasts cell changes to all connected clients.
 *
 * Features:
 * - Heartbeat mechanism for detecting stale connections
 * - Prometheus metrics for connection and message tracking
 * - Circuit breaker for Redis pub/sub resilience
 * - Idempotency for cell edit operations
 * - Redis caching for spreadsheet data
 *
 * @module websocket/server
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { pool } from '../shared/db.js';
import { redis, publishToSpreadsheet } from '../shared/redis.js';
import { v4 as uuidv4 } from 'uuid';
import logger, { createChildLogger } from '../shared/logger.js';
import {
  wsConnectionsActive,
  wsMessagesReceived,
  wsMessagesSent,
  wsMessageLatency,
  cellEditsTotal,
  cellEditLatency,
  formulaCalculationsTotal,
  formulaCalculationDuration,
  errorsTotal,
  dbQueryDuration,
} from '../shared/metrics.js';
import { createPubSubBreaker, getCircuitState } from '../shared/circuitBreaker.js';
import {
  checkIdempotency,
  storeIdempotencyResult,
  generateCellIdempotencyKey,
} from '../shared/idempotency.js';
import {
  getCachedSpreadsheet,
  setCachedSpreadsheet,
  getCachedCells,
  setCachedCells,
  updateCachedCell,
  setCachedCollaborator,
  removeCachedCollaborator,
} from '../shared/cache.js';

/** Logger for WebSocket operations */
const wsLogger = createChildLogger({ component: 'websocket' });

/**
 * Extended WebSocket interface with user and session properties.
 * Tracks user identity and spreadsheet association for each connection.
 */
interface ExtendedWebSocket extends WebSocket {
  userId?: string;
  sessionId?: string;
  spreadsheetId?: string;
  userName?: string;
  userColor?: string;
  isAlive?: boolean;
}

/**
 * Represents a collaborative editing room for a single spreadsheet.
 * Multiple users can join the same room to edit together.
 */
interface Room {
  clients: Set<ExtendedWebSocket>;
}

/**
 * In-memory mapping of spreadsheet IDs to their active rooms.
 * Each room contains all connected WebSocket clients.
 */
const rooms = new Map<string, Room>();

/**
 * Predefined color palette for collaborator presence indicators.
 * Colors cycle through the array as new users join.
 */
const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#74B9FF', '#A29BFE', '#FD79A8', '#00B894'
];

let colorIndex = 0;

/**
 * Circuit breaker for Redis pub/sub operations.
 * Protects against Redis failures during collaborative sync.
 */
const pubSubBreaker = createPubSubBreaker(
  async (channel: string, message: string) => redis.publish(channel, message)
);

/**
 * Returns the next available color from the color palette.
 * Cycles through colors to ensure visual distinction between collaborators.
 *
 * @returns A hex color code for the user's presence indicator
 */
function getNextColor(): string {
  const color = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return color;
}

/**
 * Initializes the WebSocket server for real-time collaboration.
 * Handles connection lifecycle, message routing, and room management.
 * Implements heartbeat mechanism to detect and clean up stale connections.
 *
 * @param server - The HTTP server instance to attach WebSocket handling to
 * @returns The configured WebSocketServer instance
 */
export function setupWebSocket(server: any) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Heartbeat to detect stale connections
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtendedWebSocket;
      if (extWs.isAlive === false) {
        handleDisconnect(extWs);
        return extWs.terminate();
      }
      extWs.isAlive = false;
      extWs.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  wss.on('connection', async (ws: ExtendedWebSocket, req: IncomingMessage) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Parse query params
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const spreadsheetId = url.searchParams.get('spreadsheetId');
    const sessionId = url.searchParams.get('sessionId');
    const userName = url.searchParams.get('name') || 'Anonymous';

    if (!spreadsheetId) {
      ws.close(4000, 'Missing spreadsheetId');
      return;
    }

    // Assign user identity
    ws.spreadsheetId = spreadsheetId;
    ws.sessionId = sessionId || uuidv4();
    ws.userId = uuidv4();
    ws.userName = userName;
    ws.userColor = getNextColor();

    // Join room
    if (!rooms.has(spreadsheetId)) {
      rooms.set(spreadsheetId, { clients: new Set() });
    }
    const room = rooms.get(spreadsheetId)!;
    room.clients.add(ws);

    // Update metrics
    wsConnectionsActive.inc();

    wsLogger.info(
      { userId: ws.userId, userName: ws.userName, spreadsheetId },
      'User connected'
    );

    // Cache collaborator info
    await setCachedCollaborator(spreadsheetId, ws.userId!, {
      userId: ws.userId,
      name: ws.userName,
      color: ws.userColor,
    });

    // Send current state to new client
    await sendInitialState(ws, spreadsheetId);

    // Broadcast user joined
    broadcastToRoom(spreadsheetId, {
      type: 'USER_JOINED',
      userId: ws.userId,
      name: ws.userName,
      color: ws.userColor,
    }, ws);

    // Handle messages
    ws.on('message', async (data) => {
      const start = Date.now();
      try {
        const message = JSON.parse(data.toString());
        wsMessagesReceived.labels(message.type || 'unknown').inc();

        await handleMessage(ws, message);

        const duration = Date.now() - start;
        wsMessageLatency.labels(message.type || 'unknown').observe(duration);
      } catch (e) {
        errorsTotal.labels('message_parse', 'websocket').inc();
        wsLogger.error({ error: e, userId: ws.userId }, 'Error handling message');
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      handleDisconnect(ws);
    });

    ws.on('error', (error) => {
      errorsTotal.labels('ws_connection', 'websocket').inc();
      wsLogger.error({ error, userId: ws.userId }, 'WebSocket error');
      handleDisconnect(ws);
    });
  });

  return wss;
}

/**
 * Sends the complete spreadsheet state to a newly connected client.
 * Includes spreadsheet metadata, sheets, cells, dimensions, and active collaborators.
 * Uses caching to improve performance for frequently accessed spreadsheets.
 *
 * @param ws - The WebSocket connection to send state to
 * @param spreadsheetId - The spreadsheet to load state for
 */
async function sendInitialState(ws: ExtendedWebSocket, spreadsheetId: string) {
  const start = Date.now();

  try {
    // Try to get spreadsheet from cache first
    let spreadsheetData = await getCachedSpreadsheet(spreadsheetId);

    if (!spreadsheetData) {
      // Cache miss - fetch from database
      const dbStart = Date.now();
      const spreadsheetResult = await pool.query(
        'SELECT * FROM spreadsheets WHERE id = $1',
        [spreadsheetId]
      );
      dbQueryDuration.labels('select_spreadsheet').observe(Date.now() - dbStart);

      if (spreadsheetResult.rows.length === 0) {
        // Create new spreadsheet if doesn't exist
        const createStart = Date.now();
        await pool.query(
          'INSERT INTO spreadsheets (id, title) VALUES ($1, $2)',
          [spreadsheetId, 'Untitled Spreadsheet']
        );
        await pool.query(
          'INSERT INTO sheets (spreadsheet_id, name, sheet_index) VALUES ($1, $2, 0)',
          [spreadsheetId, 'Sheet1']
        );
        dbQueryDuration.labels('create_spreadsheet').observe(Date.now() - createStart);
      }

      spreadsheetData = spreadsheetResult.rows[0] || { id: spreadsheetId, title: 'Untitled Spreadsheet' };
    }

    // Get sheets
    const sheetsStart = Date.now();
    const sheetsResult = await pool.query(
      'SELECT * FROM sheets WHERE spreadsheet_id = $1 ORDER BY sheet_index',
      [spreadsheetId]
    );
    dbQueryDuration.labels('select_sheets').observe(Date.now() - sheetsStart);

    // Get cells for first sheet (with caching)
    let cells: Record<string, any> = {};
    if (sheetsResult.rows.length > 0) {
      const sheetId = sheetsResult.rows[0].id;

      // Try cache first
      const cachedCells = await getCachedCells(sheetId);
      if (cachedCells) {
        cells = cachedCells;
      } else {
        // Cache miss - fetch from database
        const cellsStart = Date.now();
        const cellsResult = await pool.query(
          'SELECT row_index, col_index, raw_value, computed_value, format FROM cells WHERE sheet_id = $1',
          [sheetId]
        );
        dbQueryDuration.labels('select_cells').observe(Date.now() - cellsStart);

        for (const cell of cellsResult.rows) {
          const key = `${cell.row_index}-${cell.col_index}`;
          cells[key] = {
            rawValue: cell.raw_value,
            computedValue: cell.computed_value,
            format: cell.format,
          };
        }

        // Cache the cells
        await setCachedCells(sheetId, cells);
      }
    }

    // Get column widths
    const columnWidths: Record<number, number> = {};
    if (sheetsResult.rows.length > 0) {
      const widthsResult = await pool.query(
        'SELECT col_index, width FROM column_widths WHERE sheet_id = $1',
        [sheetsResult.rows[0].id]
      );
      for (const row of widthsResult.rows) {
        columnWidths[row.col_index] = row.width;
      }
    }

    // Get row heights
    const rowHeights: Record<number, number> = {};
    if (sheetsResult.rows.length > 0) {
      const heightsResult = await pool.query(
        'SELECT row_index, height FROM row_heights WHERE sheet_id = $1',
        [sheetsResult.rows[0].id]
      );
      for (const row of heightsResult.rows) {
        rowHeights[row.row_index] = row.height;
      }
    }

    // Get current collaborators from room
    const collaborators: any[] = [];
    const room = rooms.get(spreadsheetId);
    if (room) {
      for (const client of room.clients) {
        if (client !== ws && client.userId) {
          collaborators.push({
            userId: client.userId,
            name: client.userName,
            color: client.userColor,
          });
        }
      }
    }

    // Cache spreadsheet metadata for future connections
    await setCachedSpreadsheet(spreadsheetId, {
      ...spreadsheetData,
      sheets: sheetsResult.rows,
    });

    const stateMessage = {
      type: 'STATE_SYNC',
      spreadsheet: spreadsheetData,
      sheets: sheetsResult.rows,
      activeSheetId: sheetsResult.rows[0]?.id,
      cells,
      columnWidths,
      rowHeights,
      collaborators,
      user: {
        userId: ws.userId,
        name: ws.userName,
        color: ws.userColor,
      },
    };

    ws.send(JSON.stringify(stateMessage));
    wsMessagesSent.labels('STATE_SYNC').inc();

    const duration = Date.now() - start;
    wsLogger.info(
      { spreadsheetId, userId: ws.userId, cellCount: Object.keys(cells).length, duration },
      'Initial state sent'
    );
  } catch (error) {
    errorsTotal.labels('initial_state', 'websocket').inc();
    wsLogger.error({ error, spreadsheetId }, 'Error sending initial state');
    ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to load spreadsheet' }));
  }
}

/**
 * Routes incoming WebSocket messages to appropriate handlers.
 * Supports cell edits, cursor movements, selections, and dimension changes.
 *
 * @param ws - The WebSocket connection that sent the message
 * @param message - The parsed message object with type and payload
 */
async function handleMessage(ws: ExtendedWebSocket, message: any) {
  const { type, ...payload } = message;

  switch (type) {
    case 'CELL_EDIT':
      await handleCellEdit(ws, payload);
      break;

    case 'CURSOR_MOVE':
      handleCursorMove(ws, payload);
      break;

    case 'SELECTION_CHANGE':
      handleSelectionChange(ws, payload);
      break;

    case 'RESIZE_COLUMN':
      await handleResizeColumn(ws, payload);
      break;

    case 'RESIZE_ROW':
      await handleResizeRow(ws, payload);
      break;

    case 'RENAME_SHEET':
      await handleRenameSheet(ws, payload);
      break;

    default:
      wsLogger.debug({ type, userId: ws.userId }, 'Unknown message type');
  }
}

/**
 * Handles cell edit operations from clients.
 * Implements idempotency to prevent duplicate writes from retries.
 * Persists the change to the database and broadcasts to all room members.
 * Uses circuit breaker for Redis pub/sub operations.
 *
 * @param ws - The WebSocket connection that made the edit
 * @param payload - Contains sheetId, row, col, value, and optional requestId
 */
async function handleCellEdit(ws: ExtendedWebSocket, payload: any) {
  const start = Date.now();
  const { sheetId, row, col, value, requestId } = payload;

  // Check idempotency if requestId is provided
  if (requestId && ws.spreadsheetId) {
    const idempotencyKey = generateCellIdempotencyKey(
      ws.spreadsheetId,
      sheetId,
      row,
      col,
      requestId
    );

    const check = await checkIdempotency<any>(idempotencyKey);
    if (check.isReplay && check.cachedResult) {
      wsLogger.debug(
        { sheetId, row, col, requestId, userId: ws.userId },
        'Cell edit replayed from cache'
      );

      // Send cached response
      ws.send(JSON.stringify({
        type: 'CELL_EDIT_ACK',
        requestId,
        ...check.cachedResult,
      }));
      return;
    }
  }

  try {
    // Compute value (in production, use HyperFormula)
    let computedValue = value;
    if (value && value.startsWith('=')) {
      formulaCalculationsTotal.inc();
      const formulaStart = Date.now();
      computedValue = evaluateFormula(value);
      formulaCalculationDuration.observe(Date.now() - formulaStart);
    }

    // Upsert cell in database
    const dbStart = Date.now();
    await pool.query(`
      INSERT INTO cells (sheet_id, row_index, col_index, raw_value, computed_value)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (sheet_id, row_index, col_index)
      DO UPDATE SET raw_value = $4, computed_value = $5, updated_at = NOW()
    `, [sheetId, row, col, value, computedValue]);
    dbQueryDuration.labels('upsert_cell').observe(Date.now() - dbStart);

    // Update cache
    await updateCachedCell(sheetId, row, col, {
      rawValue: value,
      computedValue,
    });

    // Record metrics
    cellEditsTotal.inc();
    const duration = Date.now() - start;
    cellEditLatency.observe(duration);

    const updateMessage = {
      type: 'CELL_UPDATED',
      sheetId,
      row,
      col,
      rawValue: value,
      computedValue,
      userId: ws.userId,
    };

    // Broadcast to all clients in room
    broadcastToRoom(ws.spreadsheetId!, updateMessage);

    // Publish to Redis for multi-server support (with circuit breaker)
    const pubSubState = getCircuitState(pubSubBreaker);
    if (pubSubState === 'closed' || pubSubState === 'half-open') {
      try {
        await pubSubBreaker.fire(
          `spreadsheet:${ws.spreadsheetId}`,
          JSON.stringify(updateMessage)
        );
      } catch (e) {
        // Circuit breaker handled the failure, log for visibility
        wsLogger.warn(
          { error: e, spreadsheetId: ws.spreadsheetId, circuitState: pubSubState },
          'Pub/sub failed, operating in single-server mode'
        );
      }
    }

    // Store idempotency result if requestId was provided
    if (requestId && ws.spreadsheetId) {
      const idempotencyKey = generateCellIdempotencyKey(
        ws.spreadsheetId,
        sheetId,
        row,
        col,
        requestId
      );
      await storeIdempotencyResult(idempotencyKey, 'cell_edit', {
        sheetId,
        row,
        col,
        rawValue: value,
        computedValue,
      });
    }

    // Send acknowledgment to the client that made the edit
    ws.send(JSON.stringify({
      type: 'CELL_EDIT_ACK',
      requestId,
      sheetId,
      row,
      col,
      rawValue: value,
      computedValue,
    }));

    wsLogger.debug(
      { sheetId, row, col, duration, userId: ws.userId },
      'Cell edit processed'
    );
  } catch (error) {
    errorsTotal.labels('cell_edit', 'websocket').inc();
    wsLogger.error({ error, sheetId, row, col }, 'Error handling cell edit');
    ws.send(JSON.stringify({
      type: 'ERROR',
      message: 'Failed to save cell',
      requestId,
    }));
  }
}

/**
 * Handles cursor movement notifications from clients.
 * Broadcasts cursor position to other collaborators for presence awareness.
 *
 * @param ws - The WebSocket connection that moved its cursor
 * @param payload - Contains row and col of the cursor position
 */
function handleCursorMove(ws: ExtendedWebSocket, payload: any) {
  const { row, col } = payload;

  broadcastToRoom(ws.spreadsheetId!, {
    type: 'CURSOR_MOVED',
    userId: ws.userId,
    name: ws.userName,
    color: ws.userColor,
    row,
    col,
  }, ws);
}

/**
 * Handles selection range changes from clients.
 * Broadcasts the selection to other collaborators for visual feedback.
 *
 * @param ws - The WebSocket connection that changed its selection
 * @param payload - Contains the selection range object
 */
function handleSelectionChange(ws: ExtendedWebSocket, payload: any) {
  const { range } = payload;

  broadcastToRoom(ws.spreadsheetId!, {
    type: 'SELECTION_CHANGED',
    userId: ws.userId,
    name: ws.userName,
    color: ws.userColor,
    range,
  }, ws);
}

/**
 * Handles column resize operations from clients.
 * Persists the new width to the database and broadcasts to collaborators.
 *
 * @param ws - The WebSocket connection that resized the column
 * @param payload - Contains sheetId, col index, and new width
 */
async function handleResizeColumn(ws: ExtendedWebSocket, payload: any) {
  const { sheetId, col, width } = payload;

  try {
    const dbStart = Date.now();
    await pool.query(`
      INSERT INTO column_widths (sheet_id, col_index, width)
      VALUES ($1, $2, $3)
      ON CONFLICT (sheet_id, col_index)
      DO UPDATE SET width = $3
    `, [sheetId, col, width]);
    dbQueryDuration.labels('upsert_column_width').observe(Date.now() - dbStart);

    broadcastToRoom(ws.spreadsheetId!, {
      type: 'COLUMN_RESIZED',
      sheetId,
      col,
      width,
      userId: ws.userId,
    });

    wsMessagesSent.labels('COLUMN_RESIZED').inc();
  } catch (error) {
    errorsTotal.labels('resize_column', 'websocket').inc();
    wsLogger.error({ error, sheetId, col }, 'Error resizing column');
  }
}

/**
 * Handles row resize operations from clients.
 * Persists the new height to the database and broadcasts to collaborators.
 *
 * @param ws - The WebSocket connection that resized the row
 * @param payload - Contains sheetId, row index, and new height
 */
async function handleResizeRow(ws: ExtendedWebSocket, payload: any) {
  const { sheetId, row, height } = payload;

  try {
    const dbStart = Date.now();
    await pool.query(`
      INSERT INTO row_heights (sheet_id, row_index, height)
      VALUES ($1, $2, $3)
      ON CONFLICT (sheet_id, row_index)
      DO UPDATE SET height = $3
    `, [sheetId, row, height]);
    dbQueryDuration.labels('upsert_row_height').observe(Date.now() - dbStart);

    broadcastToRoom(ws.spreadsheetId!, {
      type: 'ROW_RESIZED',
      sheetId,
      row,
      height,
      userId: ws.userId,
    });

    wsMessagesSent.labels('ROW_RESIZED').inc();
  } catch (error) {
    errorsTotal.labels('resize_row', 'websocket').inc();
    wsLogger.error({ error, sheetId, row }, 'Error resizing row');
  }
}

/**
 * Handles sheet rename operations from clients.
 * Updates the sheet name in the database and broadcasts to collaborators.
 *
 * @param ws - The WebSocket connection that renamed the sheet
 * @param payload - Contains sheetId and new name
 */
async function handleRenameSheet(ws: ExtendedWebSocket, payload: any) {
  const { sheetId, name } = payload;

  try {
    const dbStart = Date.now();
    await pool.query('UPDATE sheets SET name = $1 WHERE id = $2', [name, sheetId]);
    dbQueryDuration.labels('update_sheet_name').observe(Date.now() - dbStart);

    broadcastToRoom(ws.spreadsheetId!, {
      type: 'SHEET_RENAMED',
      sheetId,
      name,
      userId: ws.userId,
    });

    wsMessagesSent.labels('SHEET_RENAMED').inc();
  } catch (error) {
    errorsTotal.labels('rename_sheet', 'websocket').inc();
    wsLogger.error({ error, sheetId, name }, 'Error renaming sheet');
  }
}

/**
 * Handles client disconnection cleanup.
 * Removes the client from the room and notifies remaining collaborators.
 * Cleans up the room if no clients remain.
 *
 * @param ws - The WebSocket connection that disconnected
 */
async function handleDisconnect(ws: ExtendedWebSocket) {
  if (!ws.spreadsheetId) return;

  // Update metrics
  wsConnectionsActive.dec();

  const room = rooms.get(ws.spreadsheetId);
  if (room) {
    room.clients.delete(ws);

    // Remove from collaborator cache
    if (ws.userId) {
      await removeCachedCollaborator(ws.spreadsheetId, ws.userId);
    }

    if (room.clients.size === 0) {
      rooms.delete(ws.spreadsheetId);
    } else {
      // Broadcast user left
      broadcastToRoom(ws.spreadsheetId, {
        type: 'USER_LEFT',
        userId: ws.userId,
      });
    }
  }

  wsLogger.info(
    { userId: ws.userId, userName: ws.userName, spreadsheetId: ws.spreadsheetId },
    'User disconnected'
  );
}

/**
 * Broadcasts a message to all clients in a spreadsheet room.
 * Optionally excludes a specific client (typically the sender).
 *
 * @param spreadsheetId - The spreadsheet room to broadcast to
 * @param message - The message object to send (will be JSON-stringified)
 * @param exclude - Optional WebSocket connection to exclude from broadcast
 */
function broadcastToRoom(spreadsheetId: string, message: any, exclude?: ExtendedWebSocket) {
  const room = rooms.get(spreadsheetId);
  if (!room) return;

  const data = JSON.stringify(message);
  let sentCount = 0;

  for (const client of room.clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(data);
      sentCount++;
    }
  }

  if (message.type) {
    wsMessagesSent.labels(message.type).inc(sentCount);
  }
}

/**
 * Evaluates simple spreadsheet formulas.
 * Supports basic SUM function and arithmetic expressions.
 * This is a demo implementation - production systems should use HyperFormula.
 *
 * @param formula - The formula string starting with '='
 * @returns The computed result as a string, or '#ERROR' if evaluation fails
 */
function evaluateFormula(formula: string): string {
  try {
    // Remove the = prefix
    const expr = formula.slice(1).toUpperCase();

    // Handle simple SUM, e.g., =SUM(1,2,3)
    if (expr.startsWith('SUM(')) {
      const inner = expr.slice(4, -1);
      const nums = inner.split(',').map(n => parseFloat(n.trim())).filter(n => !isNaN(n));
      return nums.reduce((a, b) => a + b, 0).toString();
    }

    // Handle simple arithmetic
    const result = Function(`"use strict"; return (${formula.slice(1)})`)();
    return String(result);
  } catch {
    return '#ERROR';
  }
}
