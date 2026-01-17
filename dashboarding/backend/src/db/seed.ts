import pool from './pool.js';
import { ingestMetrics } from '../services/metricsService.js';
import { createDashboard, createPanel } from '../services/dashboardService.js';
import { createAlertRule } from '../services/alertService.js';

async function seed() {
  console.log('Seeding database...');

  // Generate sample metrics for the last hour
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const interval = 10000; // 10 seconds

  const hosts = ['server-001', 'server-002', 'server-003'];
  const environments = ['production', 'staging'];

  const metrics: Array<{
    name: string;
    value: number;
    tags: Record<string, string>;
    timestamp: number;
  }> = [];

  // Generate CPU, memory, and disk metrics
  for (let timestamp = oneHourAgo; timestamp <= now; timestamp += interval) {
    for (const host of hosts) {
      for (const env of environments) {
        // CPU usage (40-90% with some variation)
        metrics.push({
          name: 'cpu.usage',
          value: 40 + Math.random() * 50 + Math.sin(timestamp / 60000) * 10,
          tags: { host, environment: env, datacenter: 'us-west-2' },
          timestamp,
        });

        // Memory usage (60-85%)
        metrics.push({
          name: 'memory.usage',
          value: 60 + Math.random() * 25,
          tags: { host, environment: env, datacenter: 'us-west-2' },
          timestamp,
        });

        // Disk usage (slow increase)
        const diskBase = 70 + (timestamp - oneHourAgo) / (60 * 60 * 1000) * 5;
        metrics.push({
          name: 'disk.usage',
          value: diskBase + Math.random() * 2,
          tags: { host, environment: env, datacenter: 'us-west-2' },
          timestamp,
        });

        // Network traffic (requests per second)
        metrics.push({
          name: 'network.requests_per_second',
          value: 100 + Math.random() * 400,
          tags: { host, environment: env, datacenter: 'us-west-2' },
          timestamp,
        });

        // Response time (ms)
        metrics.push({
          name: 'http.response_time_ms',
          value: 20 + Math.random() * 80 + (Math.random() > 0.95 ? 200 : 0),
          tags: { host, environment: env, datacenter: 'us-west-2' },
          timestamp,
        });

        // Error rate
        metrics.push({
          name: 'http.error_rate',
          value: Math.random() * 2 + (Math.random() > 0.98 ? 5 : 0),
          tags: { host, environment: env, datacenter: 'us-west-2' },
          timestamp,
        });
      }
    }
  }

  // Batch insert metrics
  console.log(`Ingesting ${metrics.length} sample metrics...`);
  const batchSize = 1000;
  for (let i = 0; i < metrics.length; i += batchSize) {
    const batch = metrics.slice(i, i + batchSize);
    await ingestMetrics(batch);
    console.log(`Ingested ${Math.min(i + batchSize, metrics.length)} / ${metrics.length}`);
  }

  // Create sample dashboard
  console.log('Creating sample dashboard...');
  const dashboard = await createDashboard('Infrastructure Overview', {
    description: 'Overview of system metrics',
    isPublic: true,
    layout: { columns: 12, rows: 8 },
  });

  // Create panels
  console.log('Creating panels...');

  await createPanel(dashboard.id, {
    title: 'CPU Usage',
    panelType: 'line_chart',
    query: {
      metric_name: 'cpu.usage',
      tags: { environment: 'production' },
      aggregation: 'avg',
      interval: '1m',
      group_by: ['host'],
    },
    position: { x: 0, y: 0, width: 6, height: 2 },
    panelOptions: {
      unit: '%',
      decimals: 1,
      thresholds: [
        { value: 70, color: '#ffa500' },
        { value: 90, color: '#ff0000' },
      ],
    },
  });

  await createPanel(dashboard.id, {
    title: 'Memory Usage',
    panelType: 'line_chart',
    query: {
      metric_name: 'memory.usage',
      tags: { environment: 'production' },
      aggregation: 'avg',
      interval: '1m',
      group_by: ['host'],
    },
    position: { x: 6, y: 0, width: 6, height: 2 },
    panelOptions: {
      unit: '%',
      decimals: 1,
      thresholds: [
        { value: 75, color: '#ffa500' },
        { value: 85, color: '#ff0000' },
      ],
    },
  });

  await createPanel(dashboard.id, {
    title: 'Request Rate',
    panelType: 'area_chart',
    query: {
      metric_name: 'network.requests_per_second',
      tags: { environment: 'production' },
      aggregation: 'sum',
      interval: '1m',
    },
    position: { x: 0, y: 2, width: 4, height: 2 },
    panelOptions: {
      unit: 'req/s',
      decimals: 0,
    },
  });

  await createPanel(dashboard.id, {
    title: 'Response Time (Avg)',
    panelType: 'stat',
    query: {
      metric_name: 'http.response_time_ms',
      tags: { environment: 'production' },
      aggregation: 'avg',
      interval: '5m',
    },
    position: { x: 4, y: 2, width: 4, height: 2 },
    panelOptions: {
      unit: 'ms',
      decimals: 1,
      thresholds: [
        { value: 50, color: '#00ff00' },
        { value: 100, color: '#ffa500' },
        { value: 200, color: '#ff0000' },
      ],
    },
  });

  await createPanel(dashboard.id, {
    title: 'Error Rate',
    panelType: 'gauge',
    query: {
      metric_name: 'http.error_rate',
      tags: { environment: 'production' },
      aggregation: 'avg',
      interval: '5m',
    },
    position: { x: 8, y: 2, width: 4, height: 2 },
    panelOptions: {
      unit: '%',
      decimals: 2,
      thresholds: [
        { value: 1, color: '#00ff00' },
        { value: 2, color: '#ffa500' },
        { value: 5, color: '#ff0000' },
      ],
    },
  });

  await createPanel(dashboard.id, {
    title: 'Disk Usage',
    panelType: 'bar_chart',
    query: {
      metric_name: 'disk.usage',
      tags: { environment: 'production' },
      aggregation: 'max',
      interval: '5m',
      group_by: ['host'],
    },
    position: { x: 0, y: 4, width: 12, height: 2 },
    panelOptions: {
      unit: '%',
      decimals: 1,
    },
  });

  // Create sample alert rules
  console.log('Creating alert rules...');

  await createAlertRule({
    name: 'High CPU Usage',
    description: 'Alert when CPU usage exceeds 90% for 5 minutes',
    metricName: 'cpu.usage',
    tags: { environment: 'production' },
    condition: {
      operator: '>',
      threshold: 90,
      aggregation: 'avg',
    },
    windowSeconds: 300,
    severity: 'critical',
    notifications: [{ channel: 'console', target: 'default' }],
    enabled: true,
  });

  await createAlertRule({
    name: 'High Memory Usage',
    description: 'Alert when memory usage exceeds 85% for 5 minutes',
    metricName: 'memory.usage',
    tags: { environment: 'production' },
    condition: {
      operator: '>',
      threshold: 85,
      aggregation: 'avg',
    },
    windowSeconds: 300,
    severity: 'warning',
    notifications: [{ channel: 'console', target: 'default' }],
    enabled: true,
  });

  await createAlertRule({
    name: 'High Error Rate',
    description: 'Alert when error rate exceeds 5% for 2 minutes',
    metricName: 'http.error_rate',
    tags: { environment: 'production' },
    condition: {
      operator: '>',
      threshold: 5,
      aggregation: 'avg',
    },
    windowSeconds: 120,
    severity: 'critical',
    notifications: [{ channel: 'console', target: 'default' }],
    enabled: true,
  });

  console.log('Seeding complete!');
  console.log(`Dashboard ID: ${dashboard.id}`);

  await pool.end();
}

seed().catch((error) => {
  console.error('Seeding failed:', error);
  process.exit(1);
});
