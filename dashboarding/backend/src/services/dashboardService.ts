import { v4 as uuidv4 } from 'uuid';
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

// Dashboard CRUD
export async function createDashboard(
  name: string,
  options?: {
    userId?: string;
    description?: string;
    layout?: DashboardLayout;
    isPublic?: boolean;
  }
): Promise<Dashboard> {
  const { userId, description, layout, isPublic = false } = options || {};

  const result = await pool.query<Dashboard>(
    `INSERT INTO dashboards (name, user_id, description, layout, is_public)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      name,
      userId || null,
      description || null,
      JSON.stringify(layout || { columns: 12, rows: 8 }),
      isPublic,
    ]
  );

  return result.rows[0];
}

export async function getDashboard(id: string): Promise<Dashboard | null> {
  const result = await pool.query<Dashboard>(
    `SELECT * FROM dashboards WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

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

export async function deleteDashboard(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM dashboards WHERE id = $1', [id]);
  return result.rowCount !== null && result.rowCount > 0;
}

// Panel CRUD
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

export async function getPanel(id: string): Promise<Panel | null> {
  const result = await pool.query<Panel>('SELECT * FROM panels WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getPanelsByDashboard(dashboardId: string): Promise<Panel[]> {
  const result = await pool.query<Panel>(
    'SELECT * FROM panels WHERE dashboard_id = $1 ORDER BY created_at',
    [dashboardId]
  );
  return result.rows;
}

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

export async function deletePanel(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM panels WHERE id = $1', [id]);
  return result.rowCount !== null && result.rowCount > 0;
}

// Get dashboard with panels
export async function getDashboardWithPanels(
  id: string
): Promise<(Dashboard & { panels: Panel[] }) | null> {
  const dashboard = await getDashboard(id);
  if (!dashboard) return null;

  const panels = await getPanelsByDashboard(id);

  return { ...dashboard, panels };
}
