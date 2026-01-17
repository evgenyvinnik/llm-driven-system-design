import pool from '../db.js';
import redis from '../redis.js';
import {
  PriorityQueue,
  haversineDistance,
  calculateBearing,
  calculateTurnAngle,
  formatDistance,
  formatDuration,
} from '../utils/geo.js';
import logger from '../shared/logger.js';
import {
  createCircuitBreaker,
  routingCircuitBreakerOptions,
} from '../shared/circuitBreaker.js';
import {
  routeCalculationDuration,
  routeNodesVisited,
  routeDistanceMeters,
  routeRequestsTotal,
  cacheHits,
  cacheMisses,
} from '../shared/metrics.js';

/**
 * Routing Engine using A* algorithm with traffic-aware weights
 * Enhanced with circuit breakers and metrics
 */
class RoutingService {
  constructor() {
    this.graphCache = null;
    this.graphCacheTime = null;
    this.CACHE_TTL = 60000; // 1 minute

    // Initialize circuit breaker for graph loading
    this.graphLoadBreaker = createCircuitBreaker(
      'routing_graph_load',
      this._loadGraphFromDB.bind(this),
      routingCircuitBreakerOptions,
      async () => {
        // Fallback: return cached graph if available
        if (this.graphCache) {
          logger.warn('Using stale graph cache as fallback');
          return this.graphCache;
        }
        throw new Error('No graph available');
      }
    );

    // Circuit breaker for finding nearest node (DB intensive)
    this.nearestNodeBreaker = createCircuitBreaker(
      'routing_nearest_node',
      this._findNearestNodeDB.bind(this),
      { ...routingCircuitBreakerOptions, timeout: 5000 }
    );
  }

  /**
   * Internal: Load road graph from database
   */
  async _loadGraphFromDB() {
    const nodesResult = await pool.query(`
      SELECT id, lat, lng, is_intersection
      FROM road_nodes
    `);

    const segmentsResult = await pool.query(`
      SELECT
        id, start_node_id, end_node_id, street_name, road_class,
        length_meters, free_flow_speed_kph, is_toll, is_one_way
      FROM road_segments
    `);

    // Build adjacency list
    const nodes = new Map();
    const edges = new Map();

    for (const node of nodesResult.rows) {
      nodes.set(node.id, {
        id: node.id,
        lat: parseFloat(node.lat),
        lng: parseFloat(node.lng),
        isIntersection: node.is_intersection,
      });
      edges.set(node.id, []);
    }

    for (const segment of segmentsResult.rows) {
      const edge = {
        id: segment.id,
        targetNode: segment.end_node_id,
        sourceNode: segment.start_node_id,
        streetName: segment.street_name,
        roadClass: segment.road_class,
        length: parseFloat(segment.length_meters),
        freeFlowSpeed: segment.free_flow_speed_kph,
        isToll: segment.is_toll,
        isOneWay: segment.is_one_way,
      };

      // Add forward edge
      if (edges.has(segment.start_node_id)) {
        edges.get(segment.start_node_id).push(edge);
      }

      // Add reverse edge if not one-way
      if (!segment.is_one_way && edges.has(segment.end_node_id)) {
        edges.get(segment.end_node_id).push({
          ...edge,
          targetNode: segment.start_node_id,
          sourceNode: segment.end_node_id,
        });
      }
    }

    logger.info({
      nodeCount: nodes.size,
      segmentCount: segmentsResult.rows.length,
    }, 'Road graph loaded');

    return { nodes, edges };
  }

  /**
   * Load road graph from database with caching and circuit breaker
   */
  async loadGraph() {
    // Check cache
    if (this.graphCache && Date.now() - this.graphCacheTime < this.CACHE_TTL) {
      cacheHits.inc({ cache_name: 'routing_graph' });
      return this.graphCache;
    }

    cacheMisses.inc({ cache_name: 'routing_graph' });

    // Load through circuit breaker
    const graph = await this.graphLoadBreaker.fire();

    this.graphCache = graph;
    this.graphCacheTime = Date.now();

    return graph;
  }

  /**
   * Get traffic data for segments with caching
   */
  async getTrafficData(segmentIds) {
    if (segmentIds.length === 0) return new Map();

    // Try cache first
    const cacheKey = 'traffic:current';
    const cached = await redis.get(cacheKey);

    if (cached) {
      cacheHits.inc({ cache_name: 'traffic_data' });
      return new Map(Object.entries(JSON.parse(cached)));
    }

    cacheMisses.inc({ cache_name: 'traffic_data' });

    const result = await pool.query(`
      SELECT DISTINCT ON (segment_id)
        segment_id, speed_kph, congestion_level
      FROM traffic_flow
      WHERE segment_id = ANY($1)
      ORDER BY segment_id, timestamp DESC
    `, [segmentIds]);

    const trafficMap = new Map();
    for (const row of result.rows) {
      trafficMap.set(row.segment_id, {
        speed: parseFloat(row.speed_kph),
        congestion: row.congestion_level,
      });
    }

    // Cache for 30 seconds
    await redis.setex(cacheKey, 30, JSON.stringify(Object.fromEntries(trafficMap)));

    return trafficMap;
  }

  /**
   * Internal: Find nearest node from database
   */
  async _findNearestNodeDB(lat, lng) {
    const result = await pool.query(`
      SELECT id, lat, lng,
        ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) as distance
      FROM road_nodes
      ORDER BY location <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      LIMIT 1
    `, [lat, lng]);

    if (result.rows.length === 0) {
      return null;
    }

    return {
      id: result.rows[0].id,
      lat: parseFloat(result.rows[0].lat),
      lng: parseFloat(result.rows[0].lng),
      distance: parseFloat(result.rows[0].distance),
    };
  }

  /**
   * Find nearest node to a coordinate with circuit breaker
   */
  async findNearestNode(lat, lng) {
    return this.nearestNodeBreaker.fire(lat, lng);
  }

  /**
   * A* pathfinding algorithm with metrics
   */
  async findRoute(originLat, originLng, destLat, destLng, options = {}) {
    const { avoidTolls = false, avoidHighways = false } = options;
    const endTimer = routeCalculationDuration.startTimer({ route_type: 'primary' });
    let nodesVisitedCount = 0;

    try {
      // Load graph
      const { nodes, edges } = await this.loadGraph();

      // Find nearest nodes to origin and destination
      const startNode = await this.findNearestNode(originLat, originLng);
      const goalNode = await this.findNearestNode(destLat, destLng);

      if (!startNode || !goalNode) {
        routeRequestsTotal.inc({ status: 'no_route' });
        endTimer({ status: 'no_route' });
        throw new Error('Could not find nodes near origin or destination');
      }

      // Get all segment IDs for traffic lookup
      const allSegmentIds = [];
      for (const nodeEdges of edges.values()) {
        for (const edge of nodeEdges) {
          allSegmentIds.push(edge.id);
        }
      }

      // Get traffic data
      const trafficData = await this.getTrafficData([...new Set(allSegmentIds)]);

      // A* algorithm
      const openSet = new PriorityQueue();
      const cameFrom = new Map();
      const gScore = new Map();
      const fScore = new Map();

      gScore.set(startNode.id, 0);
      fScore.set(startNode.id, this.heuristic(startNode, goalNode));
      openSet.enqueue(startNode.id, fScore.get(startNode.id));

      while (!openSet.isEmpty()) {
        const currentId = openSet.dequeue();
        nodesVisitedCount++;

        if (currentId === goalNode.id) {
          const route = this.reconstructPath(
            cameFrom,
            currentId,
            nodes,
            trafficData,
            { originLat, originLng, destLat, destLng }
          );

          // Record metrics
          routeRequestsTotal.inc({ status: 'success' });
          routeNodesVisited.observe(nodesVisitedCount);
          routeDistanceMeters.observe(route.distance);
          endTimer({ status: 'success' });

          logger.debug({
            nodesVisited: nodesVisitedCount,
            distance: route.distance,
            duration: route.duration,
          }, 'Route calculated successfully');

          return route;
        }

        const currentNode = nodes.get(currentId);
        const currentEdges = edges.get(currentId) || [];

        for (const edge of currentEdges) {
          // Apply constraints
          if (avoidTolls && edge.isToll) continue;
          if (avoidHighways && edge.roadClass === 'highway') continue;

          // Calculate edge weight (time in seconds)
          const traffic = trafficData.get(edge.id);
          const speed = traffic ? traffic.speed : edge.freeFlowSpeed;
          const weight = (edge.length / 1000) / (speed / 3600); // seconds

          const tentativeG = gScore.get(currentId) + weight;
          const neighborG = gScore.get(edge.targetNode) ?? Infinity;

          if (tentativeG < neighborG) {
            cameFrom.set(edge.targetNode, { nodeId: currentId, edge });
            gScore.set(edge.targetNode, tentativeG);

            const neighborNode = nodes.get(edge.targetNode);
            const h = this.heuristic(neighborNode, goalNode);
            fScore.set(edge.targetNode, tentativeG + h);

            openSet.enqueue(edge.targetNode, fScore.get(edge.targetNode));
          }
        }
      }

      // No route found
      routeRequestsTotal.inc({ status: 'no_route' });
      routeNodesVisited.observe(nodesVisitedCount);
      endTimer({ status: 'no_route' });

      logger.warn({
        origin: { lat: originLat, lng: originLng },
        destination: { lat: destLat, lng: destLng },
        nodesVisited: nodesVisitedCount,
      }, 'No route found');

      throw new Error('No route found');
    } catch (error) {
      if (!error.message.includes('No route found') && !error.message.includes('Could not find')) {
        routeRequestsTotal.inc({ status: 'error' });
        endTimer({ status: 'error' });
        logger.error({ error }, 'Route calculation error');
      }
      throw error;
    }
  }

  /**
   * Heuristic function for A* (straight-line distance in time)
   */
  heuristic(nodeA, nodeB) {
    if (!nodeA || !nodeB) return Infinity;

    const distance = haversineDistance(nodeA.lat, nodeA.lng, nodeB.lat, nodeB.lng);
    // Assume highway speed (100 km/h) for optimistic estimate
    const timeSeconds = (distance / 1000) / (100 / 3600);
    return timeSeconds;
  }

  /**
   * Reconstruct path from A* result
   */
  reconstructPath(cameFrom, goalId, nodes, trafficData, endpoints) {
    const path = [];
    const routeEdges = [];
    let current = goalId;

    while (cameFrom.has(current)) {
      const { nodeId, edge } = cameFrom.get(current);
      path.unshift(nodes.get(current));
      routeEdges.unshift(edge);
      current = nodeId;
    }
    path.unshift(nodes.get(current));

    // Calculate totals
    let totalDistance = 0;
    let totalTime = 0;

    for (const edge of routeEdges) {
      totalDistance += edge.length;
      const traffic = trafficData.get(edge.id);
      const speed = traffic ? traffic.speed : edge.freeFlowSpeed;
      totalTime += (edge.length / 1000) / (speed / 3600);
    }

    // Generate maneuvers
    const maneuvers = this.generateManeuvers(path, routeEdges);

    // Build path coordinates
    const coordinates = [
      { lat: endpoints.originLat, lng: endpoints.originLng },
      ...path.map(n => ({ lat: n.lat, lng: n.lng })),
      { lat: endpoints.destLat, lng: endpoints.destLng },
    ];

    return {
      coordinates,
      distance: totalDistance,
      distanceFormatted: formatDistance(totalDistance),
      duration: Math.round(totalTime),
      durationFormatted: formatDuration(totalTime),
      maneuvers,
      edges: routeEdges.map(e => ({
        id: e.id,
        streetName: e.streetName,
        length: e.length,
        roadClass: e.roadClass,
      })),
    };
  }

  /**
   * Generate turn-by-turn maneuvers
   */
  generateManeuvers(path, edges) {
    const maneuvers = [];
    let cumulativeDistance = 0;

    // Start maneuver
    maneuvers.push({
      type: 'depart',
      instruction: `Start on ${edges[0]?.streetName || 'the road'}`,
      distance: 0,
      location: path[0],
    });

    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      const nextEdge = edges[i + 1];

      cumulativeDistance += edge.length;

      if (nextEdge) {
        // Calculate turn angle
        const currentNode = path[i + 1];
        const prevNode = path[i];
        const nextNode = path[i + 2];

        if (currentNode && prevNode && nextNode) {
          const bearing1 = calculateBearing(prevNode.lat, prevNode.lng, currentNode.lat, currentNode.lng);
          const bearing2 = calculateBearing(currentNode.lat, currentNode.lng, nextNode.lat, nextNode.lng);
          const turnAngle = calculateTurnAngle(bearing1, bearing2);

          const turnType = this.classifyTurn(turnAngle);

          if (turnType !== 'straight') {
            maneuvers.push({
              type: turnType,
              instruction: this.generateInstruction(edge, nextEdge, turnType),
              distance: cumulativeDistance,
              distanceFormatted: formatDistance(cumulativeDistance),
              location: currentNode,
              streetName: nextEdge.streetName,
            });

            cumulativeDistance = 0;
          }
        }
      } else {
        // Arrive maneuver
        maneuvers.push({
          type: 'arrive',
          instruction: 'You have arrived at your destination',
          distance: cumulativeDistance,
          distanceFormatted: formatDistance(cumulativeDistance),
          location: path[path.length - 1],
        });
      }
    }

    return maneuvers;
  }

  /**
   * Classify turn angle into turn type
   */
  classifyTurn(angle) {
    const absAngle = Math.abs(angle);

    if (absAngle < 15) return 'straight';
    if (absAngle < 45) return angle > 0 ? 'slight-right' : 'slight-left';
    if (absAngle < 120) return angle > 0 ? 'right' : 'left';
    if (absAngle < 160) return angle > 0 ? 'sharp-right' : 'sharp-left';
    return 'u-turn';
  }

  /**
   * Generate instruction text for a maneuver
   */
  generateInstruction(currentEdge, nextEdge, turnType) {
    const turnPhrase = {
      'slight-right': 'Keep right onto',
      'slight-left': 'Keep left onto',
      'right': 'Turn right onto',
      'left': 'Turn left onto',
      'sharp-right': 'Turn sharp right onto',
      'sharp-left': 'Turn sharp left onto',
      'u-turn': 'Make a U-turn onto',
    };

    const streetName = nextEdge.streetName || 'the road';
    return `${turnPhrase[turnType]} ${streetName}`;
  }

  /**
   * Find alternative routes by penalizing primary route edges
   */
  async findAlternatives(originLat, originLng, destLat, destLng, primaryRoute, options = {}) {
    // For now, return empty alternatives
    // Full implementation would penalize edges in primary route
    return [];
  }
}

export default new RoutingService();
