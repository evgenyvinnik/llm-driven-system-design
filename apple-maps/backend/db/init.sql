-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Road Nodes (graph vertices)
CREATE TABLE road_nodes (
  id BIGSERIAL PRIMARY KEY,
  location GEOGRAPHY(Point, 4326) NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  is_intersection BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_nodes_location ON road_nodes USING GIST(location);
CREATE INDEX idx_nodes_lat_lng ON road_nodes(lat, lng);

-- Road Segments (graph edges)
CREATE TABLE road_segments (
  id BIGSERIAL PRIMARY KEY,
  start_node_id BIGINT NOT NULL REFERENCES road_nodes(id),
  end_node_id BIGINT NOT NULL REFERENCES road_nodes(id),
  geometry GEOGRAPHY(LineString, 4326) NOT NULL,
  street_name VARCHAR(200),
  road_class VARCHAR(50), -- highway, arterial, local, etc.
  length_meters DOUBLE PRECISION,
  free_flow_speed_kph INTEGER DEFAULT 50,
  is_toll BOOLEAN DEFAULT FALSE,
  is_one_way BOOLEAN DEFAULT FALSE,
  turn_restrictions JSONB DEFAULT '[]'
);

CREATE INDEX idx_segments_nodes ON road_segments(start_node_id, end_node_id);
CREATE INDEX idx_segments_geo ON road_segments USING GIST(geometry);
CREATE INDEX idx_segments_start ON road_segments(start_node_id);
CREATE INDEX idx_segments_end ON road_segments(end_node_id);

-- Traffic Flow (current traffic conditions)
CREATE TABLE traffic_flow (
  id BIGSERIAL PRIMARY KEY,
  segment_id BIGINT REFERENCES road_segments(id),
  timestamp TIMESTAMP DEFAULT NOW(),
  speed_kph DOUBLE PRECISION,
  congestion_level VARCHAR(20), -- free, light, moderate, heavy
  sample_count INTEGER DEFAULT 1
);

CREATE INDEX idx_traffic_segment ON traffic_flow(segment_id);
CREATE INDEX idx_traffic_timestamp ON traffic_flow(timestamp);

-- Incidents
CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id BIGINT REFERENCES road_segments(id),
  type VARCHAR(50), -- accident, construction, closure, hazard
  severity VARCHAR(20), -- low, moderate, high
  location GEOGRAPHY(Point, 4326),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  description TEXT,
  reported_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_incidents_location ON incidents USING GIST(location);
CREATE INDEX idx_incidents_active ON incidents(is_active) WHERE is_active = TRUE;

-- Points of Interest
CREATE TABLE pois (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  category VARCHAR(100),
  location GEOGRAPHY(Point, 4326) NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  address TEXT,
  phone VARCHAR(50),
  hours JSONB,
  rating DOUBLE PRECISION,
  review_count INTEGER DEFAULT 0
);

CREATE INDEX idx_pois_location ON pois USING GIST(location);
CREATE INDEX idx_pois_category ON pois(category);
CREATE INDEX idx_pois_name ON pois USING gin(to_tsvector('english', name));

-- Navigation Sessions (for tracking active navigations)
CREATE TABLE navigation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(100),
  origin_lat DOUBLE PRECISION,
  origin_lng DOUBLE PRECISION,
  destination_lat DOUBLE PRECISION,
  destination_lng DOUBLE PRECISION,
  route_data JSONB,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'active' -- active, completed, cancelled
);

CREATE INDEX idx_nav_sessions_user ON navigation_sessions(user_id);
CREATE INDEX idx_nav_sessions_status ON navigation_sessions(status);
