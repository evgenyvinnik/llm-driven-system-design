/**
 * @fileoverview Type definitions for the Dashboarding frontend.
 *
 * Defines TypeScript interfaces and types for:
 * - Dashboard and panel structures
 * - Metric data and query results
 * - Alert rules and instances
 * - Time range options
 */

// ============================================================================
// Dashboard Types
// ============================================================================

/**
 * Represents a dashboard containing multiple visualization panels.
 */
export interface Dashboard {
  id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  layout: DashboardLayout;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  panels?: Panel[];
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
 * Represents a visualization panel within a dashboard.
 */
export interface Panel {
  id: string;
  dashboard_id: string;
  title: string;
  panel_type: PanelType;
  query: PanelQuery;
  position: PanelPosition;
  options: PanelOptions;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
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
  fired_at: string;
  resolved_at: string | null;
  notification_sent: boolean;
}

// ============================================================================
// Query and Metric Types
// ============================================================================

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
  time: string;
  value: number;
}

/**
 * Metric definition (name + tag combination).
 */
export interface MetricDefinition {
  id: number;
  name: string;
  tags: Record<string, string>;
  created_at: string;
}

// ============================================================================
// Time Range Types
// ============================================================================

/**
 * Supported time range presets.
 */
export type TimeRange = '5m' | '15m' | '30m' | '1h' | '3h' | '6h' | '12h' | '24h' | '7d';

/**
 * Time range option with display label and duration.
 */
export interface TimeRangeOption {
  value: TimeRange;
  label: string;
  ms: number;
}

/**
 * Available time range options for the UI selector.
 */
export const TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  { value: '5m', label: 'Last 5 minutes', ms: 5 * 60 * 1000 },
  { value: '15m', label: 'Last 15 minutes', ms: 15 * 60 * 1000 },
  { value: '30m', label: 'Last 30 minutes', ms: 30 * 60 * 1000 },
  { value: '1h', label: 'Last 1 hour', ms: 60 * 60 * 1000 },
  { value: '3h', label: 'Last 3 hours', ms: 3 * 60 * 60 * 1000 },
  { value: '6h', label: 'Last 6 hours', ms: 6 * 60 * 60 * 1000 },
  { value: '12h', label: 'Last 12 hours', ms: 12 * 60 * 60 * 1000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
];
