/**
 * @fileoverview Type definitions for the Dashboarding backend.
 *
 * Defines TypeScript interfaces for:
 * - Metric data structures (ingestion, storage, rollups)
 * - Dashboard and panel configuration
 * - Alert rules and instances
 * - Query parameters and results
 * - User authentication
 */

// ============================================================================
// Metric Types
// ============================================================================

/**
 * Metric data point for ingestion via the API.
 */
export interface MetricDataPoint {
  name: string;
  value: number;
  tags: Record<string, string>;
  /** Unix timestamp in milliseconds */
  timestamp: number;
}

/**
 * Metric definition stored in the database.
 * Represents a unique metric name + tag combination.
 */
export interface MetricDefinition {
  id: number;
  name: string;
  tags: Record<string, string>;
  created_at: Date;
}

/**
 * Raw metric value stored in the time-series table.
 */
export interface MetricValue {
  time: Date;
  metric_id: number;
  value: number;
}

/**
 * Pre-aggregated metric for hourly/daily rollup tables.
 */
export interface AggregatedMetric {
  time: Date;
  metric_id: number;
  min_value: number;
  max_value: number;
  avg_value: number;
  count: number;
}

// ============================================================================
// Dashboard Types
// ============================================================================

/**
 * Dashboard containing multiple visualization panels.
 */
export interface Dashboard {
  id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  layout: DashboardLayout;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Grid layout configuration for a dashboard.
 */
export interface DashboardLayout {
  columns: number;
  rows: number;
}

// ============================================================================
// Panel Types
// ============================================================================

/**
 * Visualization panel (widget) on a dashboard.
 */
export interface Panel {
  id: string;
  dashboard_id: string;
  title: string;
  panel_type: PanelType;
  query: PanelQuery;
  position: PanelPosition;
  options: PanelOptions;
  created_at: Date;
  updated_at: Date;
}

/**
 * Supported panel visualization types.
 */
export type PanelType = 'line_chart' | 'area_chart' | 'bar_chart' | 'gauge' | 'stat' | 'table';

/**
 * Query configuration for fetching panel data.
 */
export interface PanelQuery {
  metric_name: string;
  tags?: Record<string, string>;
  aggregation: 'avg' | 'min' | 'max' | 'sum' | 'count';
  /** Time bucket interval, e.g., '1m', '5m', '1h' */
  interval?: string;
  group_by?: string[];
}

/**
 * Grid position and size of a panel.
 */
export interface PanelPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Display options for panel visualization.
 */
export interface PanelOptions {
  color?: string;
  unit?: string;
  decimals?: number;
  thresholds?: Threshold[];
  legend?: boolean;
}

/**
 * Threshold configuration for color-coded values.
 */
export interface Threshold {
  value: number;
  color: string;
}

// ============================================================================
// Alert Types
// ============================================================================

/**
 * Configuration for an alerting rule.
 */
export interface AlertRule {
  id: string;
  name: string;
  description: string | null;
  metric_name: string;
  tags: Record<string, string>;
  condition: AlertCondition;
  window_seconds: number;
  severity: AlertSeverity;
  notifications: AlertNotification[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Threshold condition for triggering an alert.
 */
export interface AlertCondition {
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
  threshold: number;
  aggregation: 'avg' | 'min' | 'max' | 'sum' | 'count';
}

/**
 * Alert severity levels.
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * Notification channel configuration for alerts.
 */
export interface AlertNotification {
  channel: 'console' | 'webhook';
  target: string;
}

/**
 * Instance of a triggered alert (firing or resolved).
 */
export interface AlertInstance {
  id: string;
  rule_id: string;
  status: 'firing' | 'resolved';
  value: number;
  fired_at: Date;
  resolved_at: Date | null;
  notification_sent: boolean;
}

// ============================================================================
// User Types
// ============================================================================

/**
 * User account for authentication.
 */
export interface User {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Query Types
// ============================================================================

/**
 * Parameters for a time-series metric query.
 */
export interface MetricQueryParams {
  metric_name: string;
  tags?: Record<string, string>;
  start_time: Date;
  end_time: Date;
  aggregation?: 'avg' | 'min' | 'max' | 'sum' | 'count';
  interval?: string;
  group_by?: string[];
}

/**
 * Result from a time-series query.
 */
export interface QueryResult {
  metric_name: string;
  tags: Record<string, string>;
  data: DataPoint[];
}

/**
 * Single data point in a time-series.
 */
export interface DataPoint {
  time: Date;
  value: number;
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Express session data extension for user authentication.
 */
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    role?: 'viewer' | 'editor' | 'admin';
  }
}
