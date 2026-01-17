/**
 * @fileoverview Dashboard and panel API routes with RBAC.
 *
 * Exposes REST endpoints for:
 * - Dashboard CRUD operations (list, get, create, update, delete)
 * - Panel management within dashboards
 * - Panel data fetching for rendering visualizations
 *
 * Implements Role-Based Access Control (RBAC):
 * - Viewers: Can view public dashboards and query panel data
 * - Editors: Can create/edit own dashboards, create panels
 * - Admins: Can edit/delete any dashboard
 *
 * WHY RBAC enables dashboard sharing:
 * RBAC separates authorization from authentication, allowing fine-grained
 * control over who can view vs edit dashboards. Viewers can see shared
 * dashboards without risk of accidental modifications, while editors
 * maintain control over their own content. This separation enables
 * safe sharing across teams while protecting dashboard integrity.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  createDashboard,
  getDashboard,
  getDashboards,
  updateDashboard,
  deleteDashboard,
  createPanel,
  getPanel,
  getPanelsByDashboard,
  updatePanel,
  deletePanel,
  getDashboardWithPanels,
} from '../services/dashboardService.js';
import { queryMetrics } from '../services/queryService.js';
import logger from '../shared/logger.js';
import { requireAuth, optionalAuth, requireRole, requireOwnerOrAdmin } from '../shared/auth.js';
import { dashboardRendersTotal, panelDataFetchTotal } from '../shared/metrics.js';
import type { PanelQuery } from '../types/index.js';

const router = Router();

/**
 * Zod schema for dashboard grid layout configuration.
 */
const DashboardLayoutSchema = z.object({
  columns: z.number().min(1).max(24).default(12),
  rows: z.number().min(1).max(24).default(8),
});

/**
 * Zod schema for dashboard creation requests.
 */
const CreateDashboardSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  layout: DashboardLayoutSchema.optional(),
  is_public: z.boolean().optional(),
});

/**
 * Zod schema for dashboard update requests.
 */
const UpdateDashboardSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  layout: DashboardLayoutSchema.optional(),
  is_public: z.boolean().optional(),
});

/**
 * Zod schema for panel metric query configuration.
 */
const PanelQuerySchema = z.object({
  metric_name: z.string().min(1),
  tags: z.record(z.string()).optional(),
  aggregation: z.enum(['avg', 'min', 'max', 'sum', 'count']).default('avg'),
  interval: z.string().optional(),
  group_by: z.array(z.string()).optional(),
});

/**
 * Zod schema for panel grid position.
 */
const PanelPositionSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().min(1),
  height: z.number().min(1),
});

/**
 * Zod schema for threshold configuration in panel options.
 */
const ThresholdSchema = z.object({
  value: z.number(),
  color: z.string(),
});

/**
 * Zod schema for panel display options (colors, units, thresholds).
 */
const PanelOptionsSchema = z.object({
  color: z.string().optional(),
  unit: z.string().optional(),
  decimals: z.number().min(0).max(10).optional(),
  thresholds: z.array(ThresholdSchema).optional(),
  legend: z.boolean().optional(),
});

/**
 * Zod schema for panel creation requests.
 */
const CreatePanelSchema = z.object({
  title: z.string().min(1).max(255),
  panel_type: z.enum(['line_chart', 'area_chart', 'bar_chart', 'gauge', 'stat', 'table']),
  query: PanelQuerySchema,
  position: PanelPositionSchema,
  options: PanelOptionsSchema.optional(),
});

/**
 * Zod schema for panel update requests.
 */
const UpdatePanelSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  panel_type: z.enum(['line_chart', 'area_chart', 'bar_chart', 'gauge', 'stat', 'table']).optional(),
  query: PanelQuerySchema.optional(),
  position: PanelPositionSchema.optional(),
  options: PanelOptionsSchema.optional(),
});

/**
 * GET /
 * Lists all accessible dashboards for the current user.
 * Includes user's own dashboards plus public dashboards.
 *
 * @returns {dashboards: Dashboard[]} - Array of dashboards
 */
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session?.userId;
    const dashboards = await getDashboards({ userId, includePublic: true });
    res.json({ dashboards });
  } catch (error) {
    logger.error({ error }, 'Get dashboards error');
    res.status(500).json({ error: 'Failed to get dashboards' });
  }
});

/**
 * GET /:id
 * Retrieves a single dashboard with all its panels.
 * Public dashboards are accessible to everyone.
 * Private dashboards require authentication and ownership.
 *
 * @param id - Dashboard UUID
 * @returns Dashboard with panels array
 */
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const dashboard = await getDashboardWithPanels(req.params.id);
    if (!dashboard) {
      return res.status(404).json({ error: 'Dashboard not found' });
    }

    // Check access permissions
    const userId = req.session?.userId;
    if (!dashboard.is_public && dashboard.user_id !== userId) {
      // Not public and not owner
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      // Check if admin
      if (req.session?.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    dashboardRendersTotal.inc({ status: 'success' });
    res.json(dashboard);
  } catch (error) {
    dashboardRendersTotal.inc({ status: 'error' });
    logger.error({ error, dashboardId: req.params.id }, 'Get dashboard error');
    res.status(500).json({ error: 'Failed to get dashboard' });
  }
});

/**
 * POST /
 * Creates a new dashboard.
 * Requires editor or admin role.
 *
 * @body {name, description?, layout?, is_public?}
 * @returns The newly created dashboard
 */
router.post('/', requireAuth, requireRole('editor', 'admin'), async (req: Request, res: Response) => {
  try {
    const validation = CreateDashboardSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors,
      });
    }

    const { name, description, layout, is_public } = validation.data;
    const userId = req.session?.userId;

    const dashboard = await createDashboard(name, {
      userId,
      description,
      layout,
      isPublic: is_public,
    });

    logger.info({ dashboardId: dashboard.id, userId, name }, 'Dashboard created');
    res.status(201).json(dashboard);
  } catch (error) {
    logger.error({ error }, 'Create dashboard error');
    res.status(500).json({ error: 'Failed to create dashboard' });
  }
});

/**
 * PUT /:id
 * Updates an existing dashboard's properties.
 * Only the owner or admin can update.
 *
 * @param id - Dashboard UUID
 * @body Partial dashboard properties to update
 * @returns The updated dashboard
 */
router.put(
  '/:id',
  requireAuth,
  requireOwnerOrAdmin(async (req) => {
    const dashboard = await getDashboard(req.params.id);
    return dashboard?.user_id;
  }),
  async (req: Request, res: Response) => {
    try {
      const validation = UpdateDashboardSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const dashboard = await updateDashboard(req.params.id, validation.data);
      if (!dashboard) {
        return res.status(404).json({ error: 'Dashboard not found' });
      }

      logger.info({ dashboardId: dashboard.id, userId: req.session?.userId }, 'Dashboard updated');
      res.json(dashboard);
    } catch (error) {
      logger.error({ error, dashboardId: req.params.id }, 'Update dashboard error');
      res.status(500).json({ error: 'Failed to update dashboard' });
    }
  }
);

/**
 * DELETE /:id
 * Deletes a dashboard and all its panels.
 * Only the owner or admin can delete.
 *
 * @param id - Dashboard UUID
 * @returns 204 No Content on success
 */
router.delete(
  '/:id',
  requireAuth,
  requireOwnerOrAdmin(async (req) => {
    const dashboard = await getDashboard(req.params.id);
    return dashboard?.user_id;
  }),
  async (req: Request, res: Response) => {
    try {
      const deleted = await deleteDashboard(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Dashboard not found' });
      }

      logger.info({ dashboardId: req.params.id, userId: req.session?.userId }, 'Dashboard deleted');
      res.status(204).send();
    } catch (error) {
      logger.error({ error, dashboardId: req.params.id }, 'Delete dashboard error');
      res.status(500).json({ error: 'Failed to delete dashboard' });
    }
  }
);

/**
 * GET /:dashboardId/panels
 * Lists all panels in a dashboard.
 *
 * @param dashboardId - Parent dashboard UUID
 * @returns {panels: Panel[]} - Array of panels
 */
router.get('/:dashboardId/panels', optionalAuth, async (req: Request, res: Response) => {
  try {
    // Check dashboard access first
    const dashboard = await getDashboard(req.params.dashboardId);
    if (!dashboard) {
      return res.status(404).json({ error: 'Dashboard not found' });
    }

    const userId = req.session?.userId;
    if (!dashboard.is_public && dashboard.user_id !== userId && req.session?.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const panels = await getPanelsByDashboard(req.params.dashboardId);
    res.json({ panels });
  } catch (error) {
    logger.error({ error, dashboardId: req.params.dashboardId }, 'Get panels error');
    res.status(500).json({ error: 'Failed to get panels' });
  }
});

/**
 * GET /:dashboardId/panels/:panelId
 * Retrieves a single panel.
 *
 * @param dashboardId - Parent dashboard UUID
 * @param panelId - Panel UUID
 * @returns The panel if found
 */
router.get('/:dashboardId/panels/:panelId', optionalAuth, async (req: Request, res: Response) => {
  try {
    const panel = await getPanel(req.params.panelId);
    if (!panel || panel.dashboard_id !== req.params.dashboardId) {
      return res.status(404).json({ error: 'Panel not found' });
    }
    res.json(panel);
  } catch (error) {
    logger.error({ error, panelId: req.params.panelId }, 'Get panel error');
    res.status(500).json({ error: 'Failed to get panel' });
  }
});

/**
 * POST /:dashboardId/panels
 * Creates a new panel on a dashboard.
 * Requires editor role and ownership of the dashboard.
 *
 * @param dashboardId - Parent dashboard UUID
 * @body {title, panel_type, query, position, options?}
 * @returns The newly created panel
 */
router.post(
  '/:dashboardId/panels',
  requireAuth,
  requireOwnerOrAdmin(async (req) => {
    const dashboard = await getDashboard(req.params.dashboardId);
    return dashboard?.user_id;
  }),
  async (req: Request, res: Response) => {
    try {
      const validation = CreatePanelSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const { title, panel_type, query, position, options } = validation.data;

      const panel = await createPanel(req.params.dashboardId, {
        title,
        panelType: panel_type,
        query,
        position,
        panelOptions: options,
      });

      logger.info({
        panelId: panel.id,
        dashboardId: req.params.dashboardId,
        userId: req.session?.userId,
      }, 'Panel created');

      res.status(201).json(panel);
    } catch (error) {
      logger.error({ error, dashboardId: req.params.dashboardId }, 'Create panel error');
      res.status(500).json({ error: 'Failed to create panel' });
    }
  }
);

/**
 * PUT /:dashboardId/panels/:panelId
 * Updates an existing panel's properties.
 * Requires ownership of the parent dashboard.
 *
 * @param dashboardId - Parent dashboard UUID
 * @param panelId - Panel UUID
 * @body Partial panel properties to update
 * @returns The updated panel
 */
router.put(
  '/:dashboardId/panels/:panelId',
  requireAuth,
  requireOwnerOrAdmin(async (req) => {
    const dashboard = await getDashboard(req.params.dashboardId);
    return dashboard?.user_id;
  }),
  async (req: Request, res: Response) => {
    try {
      const validation = UpdatePanelSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const { title, panel_type, query, position, options } = validation.data;

      const panel = await updatePanel(req.params.panelId, {
        title,
        panelType: panel_type,
        query,
        position,
        options,
      });

      if (!panel) {
        return res.status(404).json({ error: 'Panel not found' });
      }

      logger.info({ panelId: panel.id, userId: req.session?.userId }, 'Panel updated');
      res.json(panel);
    } catch (error) {
      logger.error({ error, panelId: req.params.panelId }, 'Update panel error');
      res.status(500).json({ error: 'Failed to update panel' });
    }
  }
);

/**
 * DELETE /:dashboardId/panels/:panelId
 * Deletes a panel from a dashboard.
 * Requires ownership of the parent dashboard.
 *
 * @param dashboardId - Parent dashboard UUID
 * @param panelId - Panel UUID
 * @returns 204 No Content on success
 */
router.delete(
  '/:dashboardId/panels/:panelId',
  requireAuth,
  requireOwnerOrAdmin(async (req) => {
    const dashboard = await getDashboard(req.params.dashboardId);
    return dashboard?.user_id;
  }),
  async (req: Request, res: Response) => {
    try {
      const deleted = await deletePanel(req.params.panelId);
      if (!deleted) {
        return res.status(404).json({ error: 'Panel not found' });
      }

      logger.info({
        panelId: req.params.panelId,
        dashboardId: req.params.dashboardId,
        userId: req.session?.userId,
      }, 'Panel deleted');

      res.status(204).send();
    } catch (error) {
      logger.error({ error, panelId: req.params.panelId }, 'Delete panel error');
      res.status(500).json({ error: 'Failed to delete panel' });
    }
  }
);

/**
 * POST /:dashboardId/panels/:panelId/data
 * Fetches metric data for a panel based on its query configuration.
 * Used by the frontend to render panel visualizations.
 *
 * @param dashboardId - Parent dashboard UUID
 * @param panelId - Panel UUID
 * @body {start_time?, end_time?} - Optional time range (defaults to last hour)
 * @returns {results: QueryResult[]} - Time-series data for the panel
 */
router.post('/:dashboardId/panels/:panelId/data', optionalAuth, async (req: Request, res: Response) => {
  try {
    const panel = await getPanel(req.params.panelId);
    if (!panel || panel.dashboard_id !== req.params.dashboardId) {
      panelDataFetchTotal.inc({ panel_type: 'unknown', status: 'not_found' });
      return res.status(404).json({ error: 'Panel not found' });
    }

    // Check dashboard access
    const dashboard = await getDashboard(req.params.dashboardId);
    if (dashboard && !dashboard.is_public) {
      const userId = req.session?.userId;
      if (dashboard.user_id !== userId && req.session?.role !== 'admin') {
        panelDataFetchTotal.inc({ panel_type: panel.panel_type, status: 'forbidden' });
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { start_time, end_time } = req.body;
    const panelQuery = panel.query as PanelQuery;

    const results = await queryMetrics({
      metric_name: panelQuery.metric_name,
      tags: panelQuery.tags,
      start_time: new Date(start_time || Date.now() - 60 * 60 * 1000),
      end_time: new Date(end_time || Date.now()),
      aggregation: panelQuery.aggregation,
      interval: panelQuery.interval || '1m',
      group_by: panelQuery.group_by,
    });

    panelDataFetchTotal.inc({ panel_type: panel.panel_type, status: 'success' });
    res.json({ results });
  } catch (error) {
    panelDataFetchTotal.inc({ panel_type: 'unknown', status: 'error' });
    logger.error({ error, panelId: req.params.panelId }, 'Get panel data error');
    res.status(500).json({ error: 'Failed to get panel data' });
  }
});

export default router;
