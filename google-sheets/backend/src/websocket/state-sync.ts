/**
 * State synchronization for new WebSocket connections.
 *
 * @description Handles loading and sending the complete spreadsheet state to newly
 * connected clients. Fetches data from cache when available, falls back to database,
 * and creates new spreadsheets on demand. Ensures new users immediately see the
 * current state of the spreadsheet and active collaborators.
 *
 * @module websocket/state-sync
 */

import { pool } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { wsMessagesSent, errorsTotal, dbQueryDuration } from '../shared/metrics.js';
import {
  getCachedSpreadsheet,
  setCachedSpreadsheet,
  getCachedCells,
  setCachedCells,
} from '../shared/cache.js';
import { ExtendedWebSocket, CellData } from './types.js';
import { getRoomCollaborators } from './connection-manager.js';

/** Logger for state sync operations */
const stateLogger = createChildLogger({ component: 'state-sync' });

/**
 * Sends the complete spreadsheet state to a newly connected client.
 *
 * @description Loads and transmits all data needed for a client to render
 * the spreadsheet, including:
 * - Spreadsheet metadata (title, settings)
 * - All sheets in the spreadsheet
 * - Cell data for the active sheet
 * - Column widths and row heights
 * - List of active collaborators
 * - The user's own identity (userId, name, color)
 *
 * Uses caching to improve performance for frequently accessed spreadsheets.
 * Creates a new spreadsheet if one doesn't exist for the given ID.
 *
 * @param {ExtendedWebSocket} ws - The WebSocket connection to send state to
 * @param {string} spreadsheetId - The unique identifier of the spreadsheet to load
 * @returns {Promise<void>} Resolves when state has been sent
 *
 * @example
 * ```typescript
 * // Called when a new user connects
 * wss.on('connection', async (ws) => {
 *   await sendInitialState(ws, spreadsheetId);
 *   // Client now has full spreadsheet state
 * });
 * ```
 */
export async function sendInitialState(
  ws: ExtendedWebSocket,
  spreadsheetId: string
): Promise<void> {
  const start = Date.now();

  try {
    // Load spreadsheet data
    const spreadsheetData = await loadSpreadsheetData(spreadsheetId);

    // Get sheets
    const sheetsStart = Date.now();
    const sheetsResult = await pool.query(
      'SELECT * FROM sheets WHERE spreadsheet_id = $1 ORDER BY sheet_index',
      [spreadsheetId]
    );
    dbQueryDuration.labels('select_sheets').observe(Date.now() - sheetsStart);

    // Get cells for first sheet (with caching)
    const cells = await loadSheetCells(sheetsResult.rows[0]?.id);

    // Get column widths and row heights
    const columnWidths = await loadColumnWidths(sheetsResult.rows[0]?.id);
    const rowHeights = await loadRowHeights(sheetsResult.rows[0]?.id);

    // Get current collaborators from room
    const collaborators = getRoomCollaborators(spreadsheetId, ws);

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
    stateLogger.info(
      { spreadsheetId, userId: ws.userId, cellCount: Object.keys(cells).length, duration },
      'Initial state sent'
    );
  } catch (error) {
    errorsTotal.labels('initial_state', 'websocket').inc();
    stateLogger.error({ error, spreadsheetId }, 'Error sending initial state');
    ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to load spreadsheet' }));
  }
}

/**
 * Loads spreadsheet data, creating it if it doesn't exist.
 *
 * @description Attempts to load spreadsheet metadata from cache first, then
 * falls back to database. If the spreadsheet doesn't exist, creates a new
 * one with a default title and initial sheet.
 *
 * @param {string} spreadsheetId - The unique identifier of the spreadsheet
 * @returns {Promise<any>} The spreadsheet metadata object
 */
async function loadSpreadsheetData(spreadsheetId: string): Promise<any> {
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

  return spreadsheetData;
}

/**
 * Loads cells for a sheet from cache or database.
 *
 * @description Attempts to load cell data from Redis cache first. On cache miss,
 * queries PostgreSQL for all cells in the sheet and populates the cache for
 * future requests.
 *
 * @param {string | undefined} sheetId - The sheet ID to load cells for
 * @returns {Promise<Record<string, CellData>>} Map of cell keys ("row-col") to cell data
 */
async function loadSheetCells(sheetId: string | undefined): Promise<Record<string, CellData>> {
  const cells: Record<string, CellData> = {};
  if (!sheetId) return cells;

  // Try cache first
  const cachedCells = await getCachedCells(sheetId);
  if (cachedCells) {
    return cachedCells;
  }

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
  return cells;
}

/**
 * Loads column widths for a sheet.
 *
 * @description Fetches all custom column widths from the database.
 * Columns without custom widths use the default width on the client.
 *
 * @param {string | undefined} sheetId - The sheet ID to load column widths for
 * @returns {Promise<Record<number, number>>} Map of column indices to widths in pixels
 */
async function loadColumnWidths(sheetId: string | undefined): Promise<Record<number, number>> {
  const columnWidths: Record<number, number> = {};
  if (!sheetId) return columnWidths;
  const widthsResult = await pool.query(
    'SELECT col_index, width FROM column_widths WHERE sheet_id = $1',
    [sheetId]
  );
  for (const row of widthsResult.rows) {
    columnWidths[row.col_index] = row.width;
  }
  return columnWidths;
}

/**
 * Loads row heights for a sheet.
 *
 * @description Fetches all custom row heights from the database.
 * Rows without custom heights use the default height on the client.
 *
 * @param {string | undefined} sheetId - The sheet ID to load row heights for
 * @returns {Promise<Record<number, number>>} Map of row indices to heights in pixels
 */
async function loadRowHeights(sheetId: string | undefined): Promise<Record<number, number>> {
  const rowHeights: Record<number, number> = {};
  if (!sheetId) return rowHeights;
  const heightsResult = await pool.query(
    'SELECT row_index, height FROM row_heights WHERE sheet_id = $1',
    [sheetId]
  );
  for (const row of heightsResult.rows) {
    rowHeights[row.row_index] = row.height;
  }
  return rowHeights;
}
