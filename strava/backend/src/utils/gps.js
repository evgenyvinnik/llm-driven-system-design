import { XMLParser } from 'fast-xml-parser';
import polyline from 'polyline';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
});

/**
 * Parse GPX file content and extract GPS points
 */
export function parseGPX(gpxContent) {
  const parsed = parser.parse(gpxContent);

  if (!parsed.gpx) {
    throw new Error('Invalid GPX file: missing gpx root element');
  }

  const gpx = parsed.gpx;
  let trackPoints = [];

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
                altitude: pt.ele ? parseFloat(pt.ele) : null,
                timestamp: pt.time ? new Date(pt.time) : null,
                heartRate: pt.extensions?.['gpxtpx:TrackPointExtension']?.['gpxtpx:hr']
                  ? parseInt(pt.extensions['gpxtpx:TrackPointExtension']['gpxtpx:hr'])
                  : null,
                cadence: pt.extensions?.['gpxtpx:TrackPointExtension']?.['gpxtpx:cad']
                  ? parseInt(pt.extensions['gpxtpx:TrackPointExtension']['gpxtpx:cad'])
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
        altitude: pt.ele ? parseFloat(pt.ele) : null,
        timestamp: pt.time ? new Date(pt.time) : null
      });
    }
  }

  // Get activity name from GPX metadata
  const name = gpx.trk?.[0]?.name || gpx.trk?.name || gpx.metadata?.name || null;

  return {
    name,
    points: trackPoints
  };
}

/**
 * Calculate activity metrics from GPS points
 */
export function calculateMetrics(points) {
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
      const timeDiff = (curr.timestamp - prev.timestamp) / 1000; // seconds
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
  if (points[0].timestamp && points[points.length - 1].timestamp) {
    elapsedTime = (points[points.length - 1].timestamp - points[0].timestamp) / 1000;
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
export function haversineDistance(lat1, lon1, lat2, lon2) {
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

function toRad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Encode GPS points to polyline format for efficient storage and map display
 */
export function encodePolyline(points) {
  const coordinates = points.map(p => [p.latitude, p.longitude]);
  return polyline.encode(coordinates);
}

/**
 * Decode polyline back to GPS points
 */
export function decodePolyline(encoded) {
  const coordinates = polyline.decode(encoded);
  return coordinates.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
}

/**
 * Calculate bounding box for a set of GPS points
 */
export function calculateBoundingBox(points) {
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
export function applyPrivacyZones(points, privacyZones) {
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
export function formatDuration(seconds) {
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
export function generateSampleRoute(startLat, startLng, numPoints = 100, activityType = 'run') {
  const points = [];
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
