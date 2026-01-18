-- Seed data for Dashboarding System
-- Creates sample metrics, dashboards, and alert rules for demo purposes

-- ============================================================================
-- Sample Metric Definitions
-- ============================================================================

-- CPU usage metrics for 3 hosts
INSERT INTO metric_definitions (name, tags) VALUES
  ('cpu.usage', '{"host": "server-001", "environment": "production", "datacenter": "us-west-2"}'),
  ('cpu.usage', '{"host": "server-002", "environment": "production", "datacenter": "us-west-2"}'),
  ('cpu.usage', '{"host": "server-003", "environment": "production", "datacenter": "us-west-2"}')
ON CONFLICT (name, tags) DO NOTHING;

-- Memory usage metrics
INSERT INTO metric_definitions (name, tags) VALUES
  ('memory.usage', '{"host": "server-001", "environment": "production", "datacenter": "us-west-2"}'),
  ('memory.usage', '{"host": "server-002", "environment": "production", "datacenter": "us-west-2"}'),
  ('memory.usage', '{"host": "server-003", "environment": "production", "datacenter": "us-west-2"}')
ON CONFLICT (name, tags) DO NOTHING;

-- Disk usage metrics
INSERT INTO metric_definitions (name, tags) VALUES
  ('disk.usage', '{"host": "server-001", "environment": "production", "datacenter": "us-west-2"}'),
  ('disk.usage', '{"host": "server-002", "environment": "production", "datacenter": "us-west-2"}'),
  ('disk.usage', '{"host": "server-003", "environment": "production", "datacenter": "us-west-2"}')
ON CONFLICT (name, tags) DO NOTHING;

-- Network metrics
INSERT INTO metric_definitions (name, tags) VALUES
  ('network.requests_per_second', '{"host": "server-001", "environment": "production", "datacenter": "us-west-2"}'),
  ('network.requests_per_second', '{"host": "server-002", "environment": "production", "datacenter": "us-west-2"}'),
  ('network.requests_per_second', '{"host": "server-003", "environment": "production", "datacenter": "us-west-2"}')
ON CONFLICT (name, tags) DO NOTHING;

-- HTTP metrics
INSERT INTO metric_definitions (name, tags) VALUES
  ('http.response_time_ms', '{"host": "server-001", "environment": "production", "datacenter": "us-west-2"}'),
  ('http.response_time_ms', '{"host": "server-002", "environment": "production", "datacenter": "us-west-2"}'),
  ('http.response_time_ms', '{"host": "server-003", "environment": "production", "datacenter": "us-west-2"}'),
  ('http.error_rate', '{"host": "server-001", "environment": "production", "datacenter": "us-west-2"}'),
  ('http.error_rate', '{"host": "server-002", "environment": "production", "datacenter": "us-west-2"}'),
  ('http.error_rate', '{"host": "server-003", "environment": "production", "datacenter": "us-west-2"}')
ON CONFLICT (name, tags) DO NOTHING;

-- ============================================================================
-- Generate sample metrics data for the last hour (10-second intervals)
-- ============================================================================

-- Generate time series data using generate_series
DO $$
DECLARE
    ts TIMESTAMPTZ;
    metric_id INTEGER;
    base_cpu FLOAT;
    base_mem FLOAT;
    base_disk FLOAT;
BEGIN
    -- Generate data for each 10-second interval in the last hour
    FOR ts IN SELECT generate_series(
        NOW() - INTERVAL '1 hour',
        NOW(),
        INTERVAL '10 seconds'
    ) LOOP
        -- Insert CPU metrics for each host
        FOR metric_id IN SELECT id FROM metric_definitions WHERE name = 'cpu.usage' LOOP
            base_cpu := 40 + random() * 50 + sin(EXTRACT(EPOCH FROM ts) / 60) * 10;
            INSERT INTO metrics (time, metric_id, value) VALUES (ts, metric_id, base_cpu);
        END LOOP;

        -- Insert memory metrics for each host
        FOR metric_id IN SELECT id FROM metric_definitions WHERE name = 'memory.usage' LOOP
            base_mem := 60 + random() * 25;
            INSERT INTO metrics (time, metric_id, value) VALUES (ts, metric_id, base_mem);
        END LOOP;

        -- Insert disk metrics for each host
        FOR metric_id IN SELECT id FROM metric_definitions WHERE name = 'disk.usage' LOOP
            -- Disk usage slowly increases over time
            base_disk := 70 + (EXTRACT(EPOCH FROM (ts - (NOW() - INTERVAL '1 hour'))) / 3600) * 5 + random() * 2;
            INSERT INTO metrics (time, metric_id, value) VALUES (ts, metric_id, base_disk);
        END LOOP;

        -- Insert network metrics for each host
        FOR metric_id IN SELECT id FROM metric_definitions WHERE name = 'network.requests_per_second' LOOP
            INSERT INTO metrics (time, metric_id, value) VALUES (ts, metric_id, 100 + random() * 400);
        END LOOP;

        -- Insert HTTP response time metrics
        FOR metric_id IN SELECT id FROM metric_definitions WHERE name = 'http.response_time_ms' LOOP
            -- Occasionally spike the response time
            INSERT INTO metrics (time, metric_id, value)
            VALUES (ts, metric_id, 20 + random() * 80 + (CASE WHEN random() > 0.95 THEN 200 ELSE 0 END));
        END LOOP;

        -- Insert HTTP error rate metrics
        FOR metric_id IN SELECT id FROM metric_definitions WHERE name = 'http.error_rate' LOOP
            -- Occasionally spike the error rate
            INSERT INTO metrics (time, metric_id, value)
            VALUES (ts, metric_id, random() * 2 + (CASE WHEN random() > 0.98 THEN 5 ELSE 0 END));
        END LOOP;
    END LOOP;
END $$;

-- ============================================================================
-- Sample Dashboard with Panels
-- ============================================================================

INSERT INTO dashboards (id, name, description, layout, is_public) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Infrastructure Overview', 'Overview of system metrics', '{"columns": 12, "rows": 8}', true)
ON CONFLICT (id) DO NOTHING;

-- CPU Usage Panel (line chart)
INSERT INTO panels (dashboard_id, title, panel_type, query, position, options) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'CPU Usage',
   'line_chart',
   '{"metric_name": "cpu.usage", "tags": {"environment": "production"}, "aggregation": "avg", "interval": "1m", "group_by": ["host"]}',
   '{"x": 0, "y": 0, "width": 6, "height": 2}',
   '{"unit": "%", "decimals": 1, "thresholds": [{"value": 70, "color": "#ffa500"}, {"value": 90, "color": "#ff0000"}]}')
ON CONFLICT DO NOTHING;

-- Memory Usage Panel (line chart)
INSERT INTO panels (dashboard_id, title, panel_type, query, position, options) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'Memory Usage',
   'line_chart',
   '{"metric_name": "memory.usage", "tags": {"environment": "production"}, "aggregation": "avg", "interval": "1m", "group_by": ["host"]}',
   '{"x": 6, "y": 0, "width": 6, "height": 2}',
   '{"unit": "%", "decimals": 1, "thresholds": [{"value": 75, "color": "#ffa500"}, {"value": 85, "color": "#ff0000"}]}')
ON CONFLICT DO NOTHING;

-- Request Rate Panel (area chart)
INSERT INTO panels (dashboard_id, title, panel_type, query, position, options) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'Request Rate',
   'area_chart',
   '{"metric_name": "network.requests_per_second", "tags": {"environment": "production"}, "aggregation": "sum", "interval": "1m"}',
   '{"x": 0, "y": 2, "width": 4, "height": 2}',
   '{"unit": "req/s", "decimals": 0}')
ON CONFLICT DO NOTHING;

-- Response Time Panel (stat)
INSERT INTO panels (dashboard_id, title, panel_type, query, position, options) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'Response Time (Avg)',
   'stat',
   '{"metric_name": "http.response_time_ms", "tags": {"environment": "production"}, "aggregation": "avg", "interval": "5m"}',
   '{"x": 4, "y": 2, "width": 4, "height": 2}',
   '{"unit": "ms", "decimals": 1, "thresholds": [{"value": 50, "color": "#00ff00"}, {"value": 100, "color": "#ffa500"}, {"value": 200, "color": "#ff0000"}]}')
ON CONFLICT DO NOTHING;

-- Error Rate Panel (gauge)
INSERT INTO panels (dashboard_id, title, panel_type, query, position, options) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'Error Rate',
   'gauge',
   '{"metric_name": "http.error_rate", "tags": {"environment": "production"}, "aggregation": "avg", "interval": "5m"}',
   '{"x": 8, "y": 2, "width": 4, "height": 2}',
   '{"unit": "%", "decimals": 2, "thresholds": [{"value": 1, "color": "#00ff00"}, {"value": 2, "color": "#ffa500"}, {"value": 5, "color": "#ff0000"}]}')
ON CONFLICT DO NOTHING;

-- Disk Usage Panel (bar chart)
INSERT INTO panels (dashboard_id, title, panel_type, query, position, options) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'Disk Usage',
   'bar_chart',
   '{"metric_name": "disk.usage", "tags": {"environment": "production"}, "aggregation": "max", "interval": "5m", "group_by": ["host"]}',
   '{"x": 0, "y": 4, "width": 12, "height": 2}',
   '{"unit": "%", "decimals": 1}')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Sample Alert Rules
-- ============================================================================

INSERT INTO alert_rules (name, description, metric_name, tags, condition, window_seconds, severity, notifications, enabled) VALUES
  ('High CPU Usage',
   'Alert when CPU usage exceeds 90% for 5 minutes',
   'cpu.usage',
   '{"environment": "production"}',
   '{"operator": ">", "threshold": 90, "aggregation": "avg"}',
   300,
   'critical',
   '[{"channel": "console", "target": "default"}]',
   true),
  ('High Memory Usage',
   'Alert when memory usage exceeds 85% for 5 minutes',
   'memory.usage',
   '{"environment": "production"}',
   '{"operator": ">", "threshold": 85, "aggregation": "avg"}',
   300,
   'warning',
   '[{"channel": "console", "target": "default"}]',
   true),
  ('High Error Rate',
   'Alert when error rate exceeds 5% for 2 minutes',
   'http.error_rate',
   '{"environment": "production"}',
   '{"operator": ">", "threshold": 5, "aggregation": "avg"}',
   120,
   'critical',
   '[{"channel": "console", "target": "default"}]',
   true)
ON CONFLICT DO NOTHING;
