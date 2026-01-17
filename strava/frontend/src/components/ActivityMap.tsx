import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import polyline from 'polyline';
import { getActivityColor } from '../utils/format';

interface ActivityMapProps {
  encodedPolyline?: string;
  points?: { latitude: number; longitude: number }[];
  activityType?: string;
  showMarkers?: boolean;
  height?: string;
  interactive?: boolean;
}

function FitBounds({ bounds }: { bounds: L.LatLngBoundsExpression }) {
  const map = useMap();
  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [map, bounds]);
  return null;
}

export function ActivityMap({
  encodedPolyline,
  points,
  activityType = 'run',
  showMarkers = true,
  height = '300px',
  interactive = true,
}: ActivityMapProps) {
  const coordinates = useMemo(() => {
    if (points && points.length > 0) {
      return points.map((p) => [p.latitude, p.longitude] as [number, number]);
    }
    if (encodedPolyline) {
      return polyline.decode(encodedPolyline) as [number, number][];
    }
    return [];
  }, [encodedPolyline, points]);

  const bounds = useMemo(() => {
    if (coordinates.length > 0) {
      return L.latLngBounds(coordinates.map(([lat, lng]) => [lat, lng]));
    }
    return null;
  }, [coordinates]);

  const center = useMemo(() => {
    if (coordinates.length > 0) {
      const midIdx = Math.floor(coordinates.length / 2);
      return coordinates[midIdx];
    }
    return [37.7749, -122.4194] as [number, number];
  }, [coordinates]);

  if (coordinates.length === 0) {
    return (
      <div
        className="bg-strava-gray-100 flex items-center justify-center text-strava-gray-500"
        style={{ height }}
      >
        No route data available
      </div>
    );
  }

  const startIcon = L.divIcon({
    className: 'custom-marker',
    html: `<div style="background: #22C55E; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  const endIcon = L.divIcon({
    className: 'custom-marker',
    html: `<div style="background: #EF4444; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  return (
    <div style={{ height }} className="rounded-lg overflow-hidden">
      <MapContainer
        center={center}
        zoom={13}
        scrollWheelZoom={interactive}
        dragging={interactive}
        zoomControl={interactive}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Polyline
          positions={coordinates}
          pathOptions={{
            color: getActivityColor(activityType),
            weight: 4,
            opacity: 0.8,
          }}
        />
        {showMarkers && coordinates.length > 0 && (
          <>
            <Marker position={coordinates[0]} icon={startIcon} />
            <Marker
              position={coordinates[coordinates.length - 1]}
              icon={endIcon}
            />
          </>
        )}
        {bounds && <FitBounds bounds={bounds} />}
      </MapContainer>
    </div>
  );
}
