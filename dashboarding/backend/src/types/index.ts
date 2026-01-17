// Metric data point for ingestion
export interface MetricDataPoint {
  name: string;
  value: number;
  tags: Record<string, string>;
  timestamp: number; // Unix milliseconds
}

// Metric definition stored in database
export interface MetricDefinition {
  id: number;
  name: string;
  tags: Record<string, string>;
  created_at: Date;
}

// Stored metric value
export interface MetricValue {
  time: Date;
  metric_id: number;
  value: number;
}

// Aggregated metric for rollups
export interface AggregatedMetric {
  time: Date;
  metric_id: number;
  min_value: number;
  max_value: number;
  avg_value: number;
  count: number;
}

// Dashboard
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

export interface DashboardLayout {
  columns: number;
  rows: number;
}

// Panel (widget on dashboard)
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

export type PanelType = 'line_chart' | 'area_chart' | 'bar_chart' | 'gauge' | 'stat' | 'table';

export interface PanelQuery {
  metric_name: string;
  tags?: Record<string, string>;
  aggregation: 'avg' | 'min' | 'max' | 'sum' | 'count';
  interval?: string; // e.g., '1m', '5m', '1h'
  group_by?: string[];
}

export interface PanelPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelOptions {
  color?: string;
  unit?: string;
  decimals?: number;
  thresholds?: Threshold[];
  legend?: boolean;
}

export interface Threshold {
  value: number;
  color: string;
}

// Alert Rule
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

export interface AlertCondition {
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
  threshold: number;
  aggregation: 'avg' | 'min' | 'max' | 'sum' | 'count';
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertNotification {
  channel: 'console' | 'webhook';
  target: string;
}

// Active alert instance
export interface AlertInstance {
  id: string;
  rule_id: string;
  status: 'firing' | 'resolved';
  value: number;
  fired_at: Date;
  resolved_at: Date | null;
  notification_sent: boolean;
}

// User
export interface User {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

// Query parameters
export interface MetricQueryParams {
  metric_name: string;
  tags?: Record<string, string>;
  start_time: Date;
  end_time: Date;
  aggregation?: 'avg' | 'min' | 'max' | 'sum' | 'count';
  interval?: string;
  group_by?: string[];
}

export interface QueryResult {
  metric_name: string;
  tags: Record<string, string>;
  data: DataPoint[];
}

export interface DataPoint {
  time: Date;
  value: number;
}

// Session
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    role?: 'user' | 'admin';
  }
}
