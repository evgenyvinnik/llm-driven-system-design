import express from 'express';
import cors from 'cors';
import pool from './db.js';
import redis from './redis.js';
import routesRouter from './routes/routes.js';
import trafficRouter from './routes/traffic.js';
import searchRouter from './routes/search.js';
import trafficService from './services/trafficService.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', async (req, res) => {
  try {
    // Check database
    await pool.query('SELECT 1');

    // Check redis
    await redis.ping();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        redis: 'connected',
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
    });
  }
});

// API Routes
app.use('/api/routes', routesRouter);
app.use('/api/traffic', trafficRouter);
app.use('/api/search', searchRouter);

// Map data endpoints
app.get('/api/map/nodes', async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;

    let query = 'SELECT id, lat, lng, is_intersection FROM road_nodes';
    let params = [];

    if (minLat && minLng && maxLat && maxLng) {
      query += ` WHERE lat BETWEEN $1 AND $3 AND lng BETWEEN $2 AND $4`;
      params = [parseFloat(minLat), parseFloat(minLng), parseFloat(maxLat), parseFloat(maxLng)];
    }

    query += ' LIMIT 5000';

    const result = await pool.query(query, params);

    res.json({
      success: true,
      nodes: result.rows,
    });
  } catch (error) {
    console.error('Nodes fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

app.get('/api/map/segments', async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;

    let query = `
      SELECT
        s.id, s.start_node_id, s.end_node_id, s.street_name, s.road_class,
        s.length_meters, s.free_flow_speed_kph, s.is_toll, s.is_one_way,
        n1.lat as start_lat, n1.lng as start_lng,
        n2.lat as end_lat, n2.lng as end_lng
      FROM road_segments s
      JOIN road_nodes n1 ON s.start_node_id = n1.id
      JOIN road_nodes n2 ON s.end_node_id = n2.id
    `;
    let params = [];

    if (minLat && minLng && maxLat && maxLng) {
      query += `
        WHERE (
          (n1.lat BETWEEN $1 AND $3 AND n1.lng BETWEEN $2 AND $4)
          OR (n2.lat BETWEEN $1 AND $3 AND n2.lng BETWEEN $2 AND $4)
        )
      `;
      params = [parseFloat(minLat), parseFloat(minLng), parseFloat(maxLat), parseFloat(maxLng)];
    }

    query += ' LIMIT 5000';

    const result = await pool.query(query, params);

    res.json({
      success: true,
      segments: result.rows,
    });
  } catch (error) {
    console.error('Segments fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch segments' });
  }
});

app.get('/api/map/pois', async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng, category, limit = 100 } = req.query;

    let query = 'SELECT id, name, category, lat, lng, address, rating FROM pois WHERE 1=1';
    let params = [];
    let paramIndex = 1;

    if (minLat && minLng && maxLat && maxLng) {
      query += ` AND lat BETWEEN $${paramIndex} AND $${paramIndex + 2} AND lng BETWEEN $${paramIndex + 1} AND $${paramIndex + 3}`;
      params.push(parseFloat(minLat), parseFloat(minLng), parseFloat(maxLat), parseFloat(maxLng));
      paramIndex += 4;
    }

    if (category) {
      query += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    query += ` ORDER BY rating DESC NULLS LAST LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      pois: result.rows,
    });
  } catch (error) {
    console.error('POIs fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch POIs' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Apple Maps backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);

  // Start traffic simulation
  trafficService.startSimulation();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  trafficService.stopSimulation();
  await pool.end();
  redis.disconnect();
  process.exit(0);
});
