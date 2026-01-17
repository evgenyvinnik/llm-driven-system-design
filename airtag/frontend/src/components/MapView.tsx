/**
 * Map view component for displaying device location history.
 * Uses Leaflet with OpenStreetMap tiles.
 * Supports location history visualization and click-to-simulate for testing.
 */

import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { Location, Device } from '../types';

/** Fix for Leaflet default marker icon paths in webpack/vite */
delete (L.Icon.Default.prototype as { _getIconUrl?: () => string })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

/**
 * Create a custom colored marker icon.
 *
 * @param color - CSS color for the marker
 * @returns Leaflet DivIcon with custom styling
 */
const createCustomIcon = (color: string) =>
  L.divIcon({
    className: 'custom-marker',
    html: `<div style="background-color: ${color}; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.3);"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10],
  });

interface MapViewProps {
  locations: Location[];
  device: Device | null;
  onMapClick?: (lat: number, lng: number) => void;
}

/**
 * Internal component that updates map view when locations change.
 * Centers the map on the first (most recent) location.
 */
function MapUpdater({ locations }: { locations: Location[] }) {
  const map = useMap();
  const hasSetView = useRef(false);

  useEffect(() => {
    if (locations.length > 0 && !hasSetView.current) {
      const latest = locations[0];
      map.setView([latest.latitude, latest.longitude], 15);
      hasSetView.current = true;
    }
  }, [locations, map]);

  return null;
}

/**
 * Internal component that handles map click events for location simulation.
 */
function ClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  const map = useMap();

  useEffect(() => {
    const handler = (e: L.LeafletMouseEvent) => {
      onClick(e.latlng.lat, e.latlng.lng);
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, onClick]);

  return null;
}

/**
 * Main map view component.
 * Displays device locations with markers and optional history path.
 * Supports click-to-simulate for testing location reports.
 *
 * @param locations - Array of location history for the device
 * @param device - The device being displayed
 * @param onMapClick - Optional callback for simulating location reports
 * @returns Interactive map with location markers
 */
export function MapView({ locations, device, onMapClick }: MapViewProps) {
  const [showHistory, setShowHistory] = useState(false);

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  // Default center (San Francisco)
  const defaultCenter: [number, number] = [37.7749, -122.4194];
  const center: [number, number] =
    locations.length > 0
      ? [locations[0].latitude, locations[0].longitude]
      : defaultCenter;

  // Create path for history line
  const historyPath: [number, number][] = locations.map((loc) => [
    loc.latitude,
    loc.longitude,
  ]);

  return (
    <div className="h-full flex flex-col">
      <div className="bg-white rounded-t-xl p-3 flex justify-between items-center border-b">
        <div className="flex items-center space-x-2">
          {device && (
            <>
              <span className="text-lg">{device.emoji || '&#128205;'}</span>
              <span className="font-medium">{device.name}</span>
            </>
          )}
        </div>
        {locations.length > 1 && (
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={`text-sm px-3 py-1 rounded-full transition ${
              showHistory
                ? 'bg-apple-blue text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {showHistory ? 'Hide History' : `Show History (${locations.length})`}
          </button>
        )}
      </div>

      <div className="flex-1 relative">
        <MapContainer
          center={center}
          zoom={15}
          style={{ height: '100%', width: '100%' }}
          className="rounded-b-xl"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapUpdater locations={locations} />
          {onMapClick && <ClickHandler onClick={onMapClick} />}

          {/* Latest location marker */}
          {locations.length > 0 && (
            <Marker
              position={[locations[0].latitude, locations[0].longitude]}
              icon={createCustomIcon('#007AFF')}
            >
              <Popup>
                <div className="text-sm">
                  <p className="font-semibold">{device?.name || 'Device'}</p>
                  <p className="text-gray-500">{formatTimestamp(locations[0].timestamp)}</p>
                  <p className="text-gray-400 text-xs mt-1">
                    {locations[0].latitude.toFixed(6)}, {locations[0].longitude.toFixed(6)}
                  </p>
                </div>
              </Popup>
            </Marker>
          )}

          {/* History markers and path */}
          {showHistory && locations.length > 1 && (
            <>
              <Polyline
                positions={historyPath}
                color="#007AFF"
                opacity={0.5}
                weight={3}
              />
              {locations.slice(1).map((loc, index) => (
                <Marker
                  key={loc.id}
                  position={[loc.latitude, loc.longitude]}
                  icon={createCustomIcon('#8E8E93')}
                >
                  <Popup>
                    <div className="text-sm">
                      <p className="font-semibold">Location #{locations.length - index - 1}</p>
                      <p className="text-gray-500">{formatTimestamp(loc.timestamp)}</p>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </>
          )}
        </MapContainer>

        {/* Click to simulate location hint */}
        {device && onMapClick && (
          <div className="absolute bottom-4 left-4 bg-white bg-opacity-90 px-3 py-2 rounded-lg shadow text-sm text-gray-600">
            Click on map to simulate location report
          </div>
        )}

        {/* No locations message */}
        {locations.length === 0 && device && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100 bg-opacity-75 rounded-b-xl">
            <div className="text-center p-6">
              <div className="text-4xl mb-3">&#128269;</div>
              <p className="text-gray-600 font-medium">No location found</p>
              <p className="text-gray-400 text-sm mt-1">
                Click on the map to simulate a location report
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
