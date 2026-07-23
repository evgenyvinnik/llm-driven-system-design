/**
 * @fileoverview Dashboard and panel CRUD operations service.
 *
 * Manages the lifecycle of dashboards (collections of visualization panels)
 * and their individual panels. Dashboards support public/private visibility
 * and can be associated with users.
 */

import { v4 as _uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import type {
  Dashboard,
  Panel,
  DashboardLayout,
  PanelQuery,
  PanelPosition,
  PanelOptions,
  PanelType,
} from '../types/index.js';

/**
 * Creates a new dashboard with the specified name and options.
 *
 * @param name - The dashboard display name
 * @param options - Optional configuration including userId, description, layout, and visibility
 * @returns The newly created dashboard record
 */
export async function createDashboard(
  name: string,
  options?: {
    id?: string;
    userId?: string;
    description?: string;
    layout?: DashboardLayout;
    isPublic?: boolean;
  }
): Promise<Dashboard> {
  const { id, userId, description, layout, isPublic = false } = options || {};

  // Allow an explicit id so seed data can use a stable, well-known dashboard id
  // (e.g. for deep links / screenshots). Omitted in normal use → DB generates one.
  const result = await pool.query<Dashboard>(
    `INSERT INTO dashboards (id, name, user_id, description, layout, is_public)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      id || null,
      name,
      userId || null,
      description || null,
      JSON.stringify(layout || { columns: 12, rows: 8 }),
      isPublic,
    ]
  );

  return result.rows[0];
}

/**
 * Retrieves a single dashboard by ID.
 *
 * @param id - The dashboard UUID
 * @returns The dashboard record, or null if not found
 */
export async function getDashboard(id: string): Promise<Dashboard | null> {
  const result = await pool.query<Dashboard>(
    `SELECT * FROM dashboards WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Retrieves dashboards based on ownership and visibility criteria.
 *
 * @param options - Filter options
 * @param options.userId - If provided, returns dashboards owned by this user
 * @param options.includePublic - Whether to include public dashboards (default: true)
 * @returns Array of matching dashboards, sorted by creation date descending
 */
export async function getDashboards(options?: {
  userId?: string;
  includePublic?: boolean;
}): Promise<Dashboard[]> {
  const { userId, includePublic = true } = options || {};
  let query = 'SELECT * FROM dashboards WHERE 1=1';
  const params: unknown[] = [];

  if (userId) {
    params.push(userId);
    if (includePublic) {
      query += ` AND (user_id = $${params.length} OR is_public = true)`;
    } else {
      query += ` AND user_id = $${params.length}`;
    }
  } else if (includePublic) {
    query += ' AND is_public = true';
  }

  query += ' ORDER BY created_at DESC';

  const result = await pool.query<Dashboard>(query, params);
  return result.rows;
}

/**
 * Updates an existing dashboard's properties.
 *
 * Only provided fields are updated; others remain unchanged.
 * Automatically updates the updated_at timestamp.
 *
 * @param id - The dashboard UUID to update
 * @param updates - Partial object with fields to update
 * @returns The updated dashboard, or null if not found
 */
export async function updateDashboard(
  id: string,
  updates: Partial<Pick<Dashboard, 'name' | 'description' | 'layout' | 'is_public'>>
): Promise<Dashboard | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    params.push(updates.name);
    setClauses.push(`name = $${params.length}`);
  }

  if (updates.description !== undefined) {
    params.push(updates.description);
    setClauses.push(`description = $${params.length}`);
  }

  if (updates.layout !== undefined) {
    params.push(JSON.stringify(updates.layout));
    setClauses.push(`layout = $${params.length}`);
  }

  if (updates.is_public !== undefined) {
    params.push(updates.is_public);
    setClauses.push(`is_public = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return getDashboard(id);
  }

  setClauses.push('updated_at = NOW()');
  params.push(id);

  const result = await pool.query<Dashboard>(
    `UPDATE dashboards SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return result.rows[0] || null;
}

/**
 * Deletes a dashboard and all its associated panels (via CASCADE).
 *
 * @param id - The dashboard UUID to delete
 * @returns true if the dashboard was deleted, false if not found
 */
export async function deleteDashboard(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM dashboards WHERE id = $1', [id]);
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Creates a new visualization panel on a dashboard.
 *
 * @param dashboardId - The parent dashboard's UUID
 * @param options - Panel configuration including title, type, query, position, and display options
 * @returns The newly created panel record
 */
export async function createPanel(
  dashboardId: string,
  options: {
    title: string;
    panelType: PanelType;
    query: PanelQuery;
    position: PanelPosition;
    panelOptions?: PanelOptions;
  }
): Promise<Panel> {
  const { title, panelType, query, position, panelOptions = {} } = options;

  const result = await pool.query<Panel>(
    `INSERT INTO panels (dashboard_id, title, panel_type, query, position, options)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      dashboardId,
      title,
      panelType,
      JSON.stringify(query),
      JSON.stringify(position),
      JSON.stringify(panelOptions),
    ]
  );

  return result.rows[0];
}

/**
 * Retrieves a single panel by ID.
 *
 * @param id - The panel UUID
 * @returns The panel record, or null if not found
 */
export async function getPanel(id: string): Promise<Panel | null> {
  const result = await pool.query<Panel>('SELECT * FROM panels WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/**
 * Retrieves all panels belonging to a specific dashboard.
 *
 * @param dashboardId - The dashboard UUID
 * @returns Array of panels, sorted by creation date
 */
export async function getPanelsByDashboard(dashboardId: string): Promise<Panel[]> {
  const result = await pool.query<Panel>(
    'SELECT * FROM panels WHERE dashboard_id = $1 ORDER BY created_at',
    [dashboardId]
  );
  return result.rows;
}

/**
 * Updates an existing panel's properties.
 *
 * Only provided fields are updated; others remain unchanged.
 * Automatically updates the updated_at timestamp.
 *
 * @param id - The panel UUID to update
 * @param updates - Partial object with fields to update
 * @returns The updated panel, or null if not found
 */
export async function updatePanel(
  id: string,
  updates: Partial<{
    title: string;
    panelType: PanelType;
    query: PanelQuery;
    position: PanelPosition;
    options: PanelOptions;
  }>
): Promise<Panel | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.title !== undefined) {
    params.push(updates.title);
    setClauses.push(`title = $${params.length}`);
  }

  if (updates.panelType !== undefined) {
    params.push(updates.panelType);
    setClauses.push(`panel_type = $${params.length}`);
  }

  if (updates.query !== undefined) {
    params.push(JSON.stringify(updates.query));
    setClauses.push(`query = $${params.length}`);
  }

  if (updates.position !== undefined) {
    params.push(JSON.stringify(updates.position));
    setClauses.push(`position = $${params.length}`);
  }

  if (updates.options !== undefined) {
    params.push(JSON.stringify(updates.options));
    setClauses.push(`options = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return getPanel(id);
  }

  setClauses.push('updated_at = NOW()');
  params.push(id);

  const result = await pool.query<Panel>(
    `UPDATE panels SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return result.rows[0] || null;
}

/**
 * Deletes a panel by ID.
 *
 * @param id - The panel UUID to delete
 * @returns true if the panel was deleted, false if not found
 */
export async function deletePanel(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM panels WHERE id = $1', [id]);
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Retrieves a dashboard along with all its panels in a single call.
 *
 * Useful for rendering a complete dashboard view on the frontend.
 *
 * @param id - The dashboard UUID
 * @returns The dashboard with panels array, or null if not found
 */
export async function getDashboardWithPanels(
  id: string
): Promise<(Dashboard & { panels: Panel[] }) | null> {
  const dashboard = await getDashboard(id);
  if (!dashboard) return null;

  const panels = await getPanelsByDashboard(id);

  return { ...dashboard, panels };
}
