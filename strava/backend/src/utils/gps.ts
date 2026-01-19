import { XMLParser } from 'fast-xml-parser';
// @ts-expect-error - no types available for polyline
import polyline from 'polyline';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
});

export interface GpsPoint {
  latitude: number;
  longitude: number;
  altitude: number | null;
  timestamp: Date | null;
  heartRate?: number | null;
  cadence?: number | null;
}

export interface ParsedGpx {
  name: string | null;
  points: GpsPoint[];
}

export interface ActivityMetrics {
  distance: number;
  elapsedTime: number;
  movingTime: number;
  elevationGain: number;
  avgSpeed: number;
  maxSpeed: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface PrivacyZone {
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
}

interface GpxTrackPoint {
  '@_lat': string;
  '@_lon': string;
  ele?: string | number;
  time?: string;
  extensions?: {
    'gpxtpx:TrackPointExtension'?: {
      'gpxtpx:hr'?: string | number;
      'gpxtpx:cad'?: string | number;
    };
  };
}

interface GpxTrackSegment {
  trkpt?: GpxTrackPoint | GpxTrackPoint[];
}

interface GpxTrack {
  name?: string;
  trkseg?: GpxTrackSegment | GpxTrackSegment[];
}

interface GpxWaypoint {
  '@_lat': string;
  '@_lon': string;
  ele?: string | number;
  time?: string;
}

interface GpxData {
  gpx?: {
    trk?: GpxTrack | GpxTrack[];
    wpt?: GpxWaypoint | GpxWaypoint[];
    metadata?: {
      name?: string;
    };
  };
}

/**
 * Parse GPX file content and extract GPS points
 */
export function parseGPX(gpxContent: string): ParsedGpx {
  const parsed = parser.parse(gpxContent) as GpxData;

  if (!parsed.gpx) {
    throw new Error('Invalid GPX file: missing gpx root element');
  }

  const gpx = parsed.gpx;
  const trackPoints: GpsPoint[] = [];

  // Handle track points
  if (gpx.trk) {
    const tracks = Array.isArray(gpx.trk) ? gpx.trk : [gpx.trk];

    for (const track of tracks) {
      if (track.trkseg) {
        const segments = Array.isArray(track.trkseg) ? track.trkseg : [track.trkseg];

        for (const segment of segments) {
          if (segment.trkpt) {
            const points = Array.isArray(segment.trkpt) ? segment.trkpt : [segment.trkpt];

            for (const pt of points) {
              trackPoints.push({
                latitude: parseFloat(pt['@_lat']),
                longitude: parseFloat(pt['@_lon']),
                altitude: pt.ele ? parseFloat(String(pt.ele)) : null,
                timestamp: pt.time ? new Date(pt.time) : null,
                heartRate: pt.extensions?.['gpxtpx:TrackPointExtension']?.['gpxtpx:hr']
                  ? parseInt(String(pt.extensions['gpxtpx:TrackPointExtension']['gpxtpx:hr']))
                  : null,
                cadence: pt.extensions?.['gpxtpx:TrackPointExtension']?.['gpxtpx:cad']
                  ? parseInt(String(pt.extensions['gpxtpx:TrackPointExtension']['gpxtpx:cad']))
                  : null
              });
            }
          }
        }
      }
    }
  }

  // Handle waypoints if no track points
  if (trackPoints.length === 0 && gpx.wpt) {
    const waypoints = Array.isArray(gpx.wpt) ? gpx.wpt : [gpx.wpt];

    for (const pt of waypoints) {
      trackPoints.push({
        latitude: parseFloat(pt['@_lat']),
        longitude: parseFloat(pt['@_lon']),
        altitude: pt.ele ? parseFloat(String(pt.ele)) : null,
        timestamp: pt.time ? new Date(pt.time) : null
      });
    }
  }

  // Get activity name from GPX metadata
  const tracks = gpx.trk ? (Array.isArray(gpx.trk) ? gpx.trk : [gpx.trk]) : [];
  const name = tracks[0]?.name || gpx.metadata?.name || null;

  return {
    name,
    points: trackPoints
  };
}

/**
 * Calculate activity metrics from GPS points
 */
export function calculateMetrics(points: GpsPoint[]): ActivityMetrics {
  if (!points || points.length < 2) {
    return {
      distance: 0,
      elapsedTime: 0,
      movingTime: 0,
      elevationGain: 0,
      avgSpeed: 0,
      maxSpeed: 0
    };
  }

  let totalDistance = 0;
  let elevationGain = 0;
  let maxSpeed = 0;
  let movingTime = 0;
  const MOVING_THRESHOLD = 0.5; // m/s, below this is considered stopped

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    // Calculate distance using Haversine formula
    const dist = haversineDistance(
      prev.latitude, prev.longitude,
      curr.latitude, curr.longitude
    );
    totalDistance += dist;

    // Calculate elevation gain (only positive changes)
    if (curr.altitude && prev.altitude) {
      const elevDiff = curr.altitude - prev.altitude;
      if (elevDiff > 0) {
        elevationGain += elevDiff;
      }
    }

    // Calculate speed between points
    if (curr.timestamp && prev.timestamp) {
      const timeDiff = (curr.timestamp.getTime() - prev.timestamp.getTime()) / 1000; // seconds
      if (timeDiff > 0) {
        const speed = dist / timeDiff; // m/s
        if (speed > maxSpeed && speed < 50) { // Filter unrealistic speeds (50 m/s = 180 km/h)
          maxSpeed = speed;
        }
        if (speed >= MOVING_THRESHOLD) {
          movingTime += timeDiff;
        }
      }
    }
  }

  // Calculate elapsed time from first to last point
  let elapsedTime = 0;
  const firstTimestamp = points[0].timestamp;
  const lastTimestamp = points[points.length - 1].timestamp;
  if (firstTimestamp && lastTimestamp) {
    elapsedTime = (lastTimestamp.getTime() - firstTimestamp.getTime()) / 1000;
  }

  // Calculate average speed (distance / moving time)
  const avgSpeed = movingTime > 0 ? totalDistance / movingTime : 0;

  return {
    distance: Math.round(totalDistance * 100) / 100, // meters, 2 decimal places
    elapsedTime: Math.round(elapsedTime),
    movingTime: Math.round(movingTime),
    elevationGain: Math.round(elevationGain * 100) / 100,
    avgSpeed: Math.round(avgSpeed * 100) / 100, // m/s
    maxSpeed: Math.round(maxSpeed * 100) / 100
  };
}

/**
 * Calculate distance between two GPS coordinates using Haversine formula
 */
export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Encode GPS points to polyline format for efficient storage and map display
 */
export function encodePolyline(points: GpsPoint[]): string {
  const coordinates: [number, number][] = points.map(p => [p.latitude, p.longitude]);
  return polyline.encode(coordinates);
}

/**
 * Decode polyline back to GPS points
 */
export function decodePolyline(encoded: string): GpsPoint[] {
  const coordinates = polyline.decode(encoded) as [number, number][];
  return coordinates.map(([lat, lng]) => ({
    latitude: lat,
    longitude: lng,
    altitude: null,
    timestamp: null
  }));
}

/**
 * Calculate bounding box for a set of GPS points
 */
export function calculateBoundingBox(points: GpsPoint[]): BoundingBox | null {
  if (!points || points.length === 0) {
    return null;
  }

  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;

  for (const point of points) {
    minLat = Math.min(minLat, point.latitude);
    maxLat = Math.max(maxLat, point.latitude);
    minLng = Math.min(minLng, point.longitude);
    maxLng = Math.max(maxLng, point.longitude);
  }

  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Apply privacy zones to GPS points (remove points within zones)
 */
export function applyPrivacyZones(points: GpsPoint[], privacyZones: PrivacyZone[]): GpsPoint[] {
  if (!privacyZones || privacyZones.length === 0) {
    return points;
  }

  return points.filter(point => {
    return !privacyZones.some(zone => {
      const distance = haversineDistance(
        point.latitude, point.longitude,
        zone.centerLat, zone.centerLng
      );
      return distance < zone.radiusMeters;
    });
  });
}

/**
 * Format duration in seconds to human-readable string
 */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Generate sample GPS points for testing (simulates a route)
 */
export function generateSampleRoute(
  startLat: number,
  startLng: number,
  numPoints: number = 100,
  activityType: string = 'run'
): GpsPoint[] {
  const points: GpsPoint[] = [];
  let lat = startLat;
  let lng = startLng;
  let altitude = 100 + Math.random() * 50;
  const startTime = new Date();

  // Speed in degrees per point (roughly)
  const speed = activityType === 'ride' ? 0.0005 : 0.0002;

  for (let i = 0; i < numPoints; i++) {
    // Add some variation to the path
    const angle = Math.random() * Math.PI / 4 + Math.PI / 4; // Mostly northeast
    lat += Math.cos(angle) * speed + (Math.random() - 0.5) * 0.0001;
    lng += Math.sin(angle) * speed + (Math.random() - 0.5) * 0.0001;

    // Vary altitude
    altitude += (Math.random() - 0.4) * 3; // Slight uphill bias
    altitude = Math.max(0, altitude);

    const timestamp = new Date(startTime.getTime() + i * (activityType === 'ride' ? 2000 : 5000));

    points.push({
      latitude: parseFloat(lat.toFixed(7)),
      longitude: parseFloat(lng.toFixed(7)),
      altitude: parseFloat(altitude.toFixed(2)),
      timestamp,
      heartRate: 120 + Math.floor(Math.random() * 40),
      cadence: activityType === 'run' ? 160 + Math.floor(Math.random() * 20) : null
    });
  }

  return points;
}
