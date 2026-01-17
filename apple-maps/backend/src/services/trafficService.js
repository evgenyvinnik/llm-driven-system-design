import pool from '../db.js';
import redis from '../redis.js';
import logger from '../shared/logger.js';
import {
  trafficProbesIngested,
  trafficSegmentUpdates,
  trafficIncidentsDetected,
  trafficSegmentStaleness,
} from '../shared/metrics.js';
import {
  checkIdempotency,
  startIdempotentRequest,
  completeIdempotentRequest,
} from '../shared/idempotency.js';

/**
 * Traffic Service for real-time traffic data and simulation
 * Enhanced with structured logging, metrics, and idempotency
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

    logger.info('Starting traffic simulation');

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
      logger.info('Traffic simulation stopped');
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

      let updateCount = 0;

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

        updateCount++;
      }

      // Update metrics
      trafficSegmentUpdates.inc(updateCount);
      trafficSegmentStaleness.set(0); // Just updated

      // Update Redis cache
      await redis.setex(
        'traffic:current',
        30,
        JSON.stringify(Object.fromEntries(this.simulatedTraffic))
      );

      logger.debug({ segmentCount: updateCount }, 'Traffic simulation update complete');
    } catch (error) {
      logger.error({ error }, 'Traffic simulation error');
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
   * Ingest a GPS probe with idempotency
   * @param {Object} probe - GPS probe data
   * @returns {Object} - Processing result
   */
  async ingestProbe(probe) {
    const { deviceId, latitude, longitude, speed, heading, timestamp } = probe;

    // Create idempotency key from device ID and timestamp
    const idempotencyKey = `${deviceId}:${timestamp}`;

    // Check for duplicate probe
    const existing = await checkIdempotency('gps_probe', idempotencyKey);
    if (existing?.isReplay) {
      trafficProbesIngested.inc({ status: 'duplicate' });
      logger.debug({ deviceId, timestamp }, 'Duplicate GPS probe ignored');
      return { status: 'duplicate', processed: false };
    }

    // Start idempotent request
    const acquired = await startIdempotentRequest('gps_probe', idempotencyKey, 3600); // 1 hour TTL
    if (!acquired) {
      trafficProbesIngested.inc({ status: 'duplicate' });
      return { status: 'duplicate', processed: false };
    }

    try {
      // Find nearest segment for map matching
      const segment = await this.mapMatchProbe(latitude, longitude, heading);

      if (!segment) {
        trafficProbesIngested.inc({ status: 'no_match' });
        logger.debug({ latitude, longitude }, 'GPS probe could not be map matched');
        return { status: 'no_match', processed: false };
      }

      // Update segment flow (exponential moving average)
      const current = this.simulatedTraffic.get(segment.id) || {
        speed: segment.free_flow_speed_kph,
        samples: 0,
      };

      const alpha = 0.1; // Smoothing factor
      const newSpeed = alpha * speed + (1 - alpha) * current.speed;

      this.simulatedTraffic.set(segment.id, {
        speed: newSpeed,
        samples: (current.samples || 0) + 1,
        congestion: this.calculateCongestion(newSpeed, segment.free_flow_speed_kph),
        timestamp: new Date(),
      });

      trafficProbesIngested.inc({ status: 'processed' });
      trafficSegmentUpdates.inc();

      // Complete idempotent request
      await completeIdempotentRequest('gps_probe', idempotencyKey, {
        status: 'processed',
        segmentId: segment.id,
      });

      logger.debug({
        segmentId: segment.id,
        speed: newSpeed,
        samples: current.samples + 1,
      }, 'GPS probe processed');

      return { status: 'processed', processed: true, segmentId: segment.id };
    } catch (error) {
      trafficProbesIngested.inc({ status: 'error' });
      logger.error({ error, probe }, 'GPS probe processing error');
      throw error;
    }
  }

  /**
   * Map match a GPS coordinate to a road segment
   */
  async mapMatchProbe(latitude, longitude, heading) {
    try {
      const result = await pool.query(`
        SELECT id, free_flow_speed_kph, street_name,
          ST_Distance(geometry, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) as distance
        FROM road_segments
        WHERE ST_DWithin(geometry, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, 50)
        ORDER BY distance
        LIMIT 1
      `, [latitude, longitude]);

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, latitude, longitude }, 'Map matching error');
      return null;
    }
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
   * Report an incident with idempotency
   */
  async reportIncident(data) {
    const { lat, lng, type, severity, description, clientRequestId } = data;

    // Check for idempotent replay if client provided request ID
    if (clientRequestId) {
      const existing = await checkIdempotency('incident_report', clientRequestId);
      if (existing?.isReplay) {
        logger.debug({ clientRequestId }, 'Duplicate incident report ignored');
        return existing.result;
      }

      const acquired = await startIdempotentRequest('incident_report', clientRequestId);
      if (!acquired) {
        return { action: 'duplicate', message: 'Incident report already processing' };
      }
    }

    try {
      // Check for nearby existing incident (merge logic)
      const nearbyIncident = await this.findNearbyIncident(lat, lng, 100);

      if (nearbyIncident) {
        // Merge with existing incident
        await pool.query(`
          UPDATE incidents
          SET confidence = LEAST(confidence + 0.1, 1.0),
              sample_count = COALESCE(sample_count, 1) + 1,
              last_reported_at = NOW()
          WHERE id = $1
        `, [nearbyIncident.id]);

        trafficIncidentsDetected.inc({ type, severity: 'merged' });

        const result = {
          action: 'merged',
          incidentId: nearbyIncident.id,
          message: 'Incident merged with existing report',
        };

        if (clientRequestId) {
          await completeIdempotentRequest('incident_report', clientRequestId, result);
        }

        logger.info({ incidentId: nearbyIncident.id, type }, 'Incident merged');
        return result;
      }

      // Find nearest segment
      const segmentResult = await pool.query(`
        SELECT id
        FROM road_segments
        ORDER BY geometry <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
        LIMIT 1
      `, [lat, lng]);

      const segmentId = segmentResult.rows[0]?.id;

      const insertResult = await pool.query(`
        INSERT INTO incidents (
          segment_id, lat, lng, location, type, severity, description,
          confidence, sample_count, idempotency_key
        )
        VALUES (
          $1, $2, $3, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
          $5, $6, $7, 0.5, 1, $8
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id, segment_id, lat, lng, type, severity, description, reported_at
      `, [segmentId, lat, lng, lng, type, severity, description, clientRequestId]);

      if (insertResult.rows.length === 0) {
        // Conflict on idempotency key
        return { action: 'duplicate', message: 'Incident already reported' };
      }

      trafficIncidentsDetected.inc({ type, severity });

      const result = {
        action: 'created',
        incident: insertResult.rows[0],
      };

      if (clientRequestId) {
        await completeIdempotentRequest('incident_report', clientRequestId, result);
      }

      logger.info({
        incidentId: insertResult.rows[0].id,
        type,
        severity,
        location: { lat, lng },
      }, 'New incident reported');

      return result;
    } catch (error) {
      logger.error({ error, data }, 'Incident report error');
      throw error;
    }
  }

  /**
   * Find a nearby active incident
   */
  async findNearbyIncident(lat, lng, radiusMeters) {
    const result = await pool.query(`
      SELECT id, type, severity
      FROM incidents
      WHERE is_active = TRUE
        AND ST_DWithin(
          location,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          $3
        )
      ORDER BY ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)
      LIMIT 1
    `, [lat, lng, radiusMeters]);

    return result.rows[0] || null;
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

    logger.info({ incidentId }, 'Incident resolved');
  }
}

export default new TrafficService();
