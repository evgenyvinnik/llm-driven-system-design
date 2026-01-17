export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  created_at: string;
}

export interface Device {
  id: string;
  user_id: string;
  device_type: string;
  device_name: string;
  device_identifier: string;
  priority: number;
  last_sync: string | null;
  created_at: string;
}

export interface HealthSample {
  id: string;
  user_id: string;
  type: string;
  value: number;
  unit: string;
  start_date: string;
  end_date: string;
  source_device: string;
  source_app: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface HealthAggregate {
  date: string;
  value: number;
  minValue: number;
  maxValue: number;
  sampleCount: number;
}

export interface HealthDataType {
  type: string;
  display_name: string;
  unit: string;
  aggregation: string;
  category: string;
  description: string;
}

export interface HealthInsight {
  id: string;
  user_id: string;
  type: string;
  severity: 'positive' | 'medium' | 'high';
  direction: 'increased' | 'decreased' | null;
  message: string;
  recommendation: string;
  data: Record<string, unknown>;
  acknowledged: boolean;
  created_at: string;
}

export interface DailySummary {
  [type: string]: {
    value: number;
    minValue: number;
    maxValue: number;
    sampleCount: number;
  };
}

export interface WeeklySummary {
  [type: string]: {
    total: number;
    average: number;
    minValue: number;
    maxValue: number;
    sampleCount: number;
  };
}

export interface LatestMetrics {
  [type: string]: {
    value: number;
    date: string;
  };
}
