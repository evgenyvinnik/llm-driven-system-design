import pool from '../db.js';
import redis from '../redis.js';

/**
 * Traffic Service for real-time traffic data and simulation
 */
class TrafficService {
  constructor() {
    this.simulatedTraffic = new Map();
    this.simulationInterval = null;
  }

  /**
   * Start traffic simulation
   */
  startSimulation() {
    if (this.simulationInterval) return;

    console.log('Starting traffic simulation...');

    this.simulationInterval = setInterval(async () => {
      await this.simulateTrafficUpdate();
    }, 10000); // Update every 10 seconds

    // Initial simulation
    this.simulateTrafficUpdate();
  }

  /**
   * Stop traffic simulation
   */
  stopSimulation() {
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
  }

  /**
   * Simulate traffic updates for all segments
   */
  async simulateTrafficUpdate() {
    try {
      const segments = await pool.query(`
        SELECT id, free_flow_speed_kph, road_class
        FROM road_segments
      `);

      const now = new Date();
      const hour = now.getHours();

      // Simulate rush hour traffic (7-9 AM and 5-7 PM)
      const isRushHour = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19);
      const trafficMultiplier = isRushHour ? 0.5 : 0.85;

      for (const segment of segments.rows) {
        // Random variation in speed
        const variation = 0.8 + Math.random() * 0.4; // 80% to 120%
        const baseMultiplier = segment.road_class === 'highway' ?
          trafficMultiplier : trafficMultiplier * 0.9;

        const speed = segment.free_flow_speed_kph * baseMultiplier * variation;
        const congestionLevel = this.calculateCongestion(speed, segment.free_flow_speed_kph);

        this.simulatedTraffic.set(segment.id, {
          speed: Math.round(speed * 10) / 10,
          congestion: congestionLevel,
          timestamp: now,
        });

        // Store in database (batch insert)
        await pool.query(`
          INSERT INTO traffic_flow (segment_id, speed_kph, congestion_level, timestamp)
          VALUES ($1, $2, $3, $4)
        `, [segment.id, speed, congestionLevel, now]);
      }

      // Update Redis cache
      await redis.setex(
        'traffic:current',
        30,
        JSON.stringify(Object.fromEntries(this.simulatedTraffic))
      );

      console.log(`Updated traffic for ${segments.rows.length} segments`);
    } catch (error) {
      console.error('Traffic simulation error:', error);
    }
  }

  /**
   * Calculate congestion level based on current speed vs free flow
   */
  calculateCongestion(currentSpeed, freeFlowSpeed) {
    const ratio = currentSpeed / freeFlowSpeed;

    if (ratio > 0.8) return 'free';
    if (ratio > 0.5) return 'light';
    if (ratio > 0.25) return 'moderate';
    return 'heavy';
  }

  /**
   * Get current traffic for segments
   */
  async getTraffic(segmentIds) {
    const result = [];

    for (const id of segmentIds) {
      const traffic = this.simulatedTraffic.get(id);
      if (traffic) {
        result.push({
          segmentId: id,
          ...traffic,
        });
      }
    }

    return result;
  }

  /**
   * Get traffic for a bounding box
   */
  async getTrafficInBounds(minLat, minLng, maxLat, maxLng) {
    const result = await pool.query(`
      SELECT DISTINCT ON (s.id)
        s.id,
        s.street_name,
        s.free_flow_speed_kph,
        tf.speed_kph,
        tf.congestion_level,
        ST_AsGeoJSON(s.geometry) as geometry
      FROM road_segments s
      LEFT JOIN traffic_flow tf ON s.id = tf.segment_id
      WHERE ST_Intersects(
        s.geometry,
        ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
      )
      ORDER BY s.id, tf.timestamp DESC
    `, [minLng, minLat, maxLng, maxLat]);

    return result.rows.map(row => ({
      segmentId: row.id,
      streetName: row.street_name,
      freeFlowSpeed: row.free_flow_speed_kph,
      currentSpeed: row.speed_kph,
      congestion: row.congestion_level || 'free',
      geometry: row.geometry ? JSON.parse(row.geometry) : null,
    }));
  }

  /**
   * Report an incident
   */
  async reportIncident(data) {
    const { lat, lng, type, severity, description } = data;

    // Find nearest segment
    const segmentResult = await pool.query(`
      SELECT id
      FROM road_segments
      ORDER BY geometry <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      LIMIT 1
    `, [lat, lng]);

    const segmentId = segmentResult.rows[0]?.id;

    const result = await pool.query(`
      INSERT INTO incidents (segment_id, lat, lng, location, type, severity, description)
      VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5, $6, $7)
      RETURNING id, segment_id, lat, lng, type, severity, description, reported_at
    `, [segmentId, lat, lng, lng, type, severity, description]);

    return result.rows[0];
  }

  /**
   * Get active incidents in bounding box
   */
  async getIncidents(minLat, minLng, maxLat, maxLng) {
    const result = await pool.query(`
      SELECT id, segment_id, lat, lng, type, severity, description, reported_at
      FROM incidents
      WHERE is_active = TRUE
      AND lat BETWEEN $1 AND $3
      AND lng BETWEEN $2 AND $4
      ORDER BY reported_at DESC
    `, [minLat, minLng, maxLat, maxLng]);

    return result.rows;
  }

  /**
   * Resolve an incident
   */
  async resolveIncident(incidentId) {
    await pool.query(`
      UPDATE incidents
      SET is_active = FALSE, resolved_at = NOW()
      WHERE id = $1
    `, [incidentId]);
  }
}

export default new TrafficService();
