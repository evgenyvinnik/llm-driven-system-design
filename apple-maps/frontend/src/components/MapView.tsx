import { useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, useMap, useMapEvents, Marker, Popup, Polyline, CircleMarker } from 'react-leaflet';
import L from 'leaflet';
import { useMapStore } from '../stores/mapStore';
import type { LatLng, Place, TrafficData } from '../types';

// Custom marker icons
const createIcon = (color: string, size: number = 12) => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="
      background-color: ${color};
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      border: 2px solid white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

const originIcon = createIcon('#007AFF', 16);
const destinationIcon = createIcon('#FF3B30', 16);

// POI icons by category
const poiIcons: Record<string, L.DivIcon> = {
  restaurant: createIcon('#FF9500', 10),
  coffee: createIcon('#8B4513', 10),
  gas_station: createIcon('#FF3B30', 10),
  hotel: createIcon('#5856D6', 10),
  park: createIcon('#34C759', 10),
  shopping: createIcon('#FF2D55', 10),
  hospital: createIcon('#FF3B30', 10),
  default: createIcon('#007AFF', 10),
};

// Map event handler component
function MapEventHandler() {
  const { setOrigin, setDestination, origin, destination } = useMapStore();

  useMapEvents({
    click: (e) => {
      const { lat, lng } = e.latlng;
      const point: LatLng = { lat, lng };

      if (!origin) {
        setOrigin(point);
      } else if (!destination) {
        setDestination(point);
      }
    },
  });

  return null;
}

// Component to sync map view with store
function MapViewController() {
  const map = useMap();
  const { center, zoom, setCenter, setZoom } = useMapStore();

  useEffect(() => {
    map.setView([center.lat, center.lng], zoom);
  }, [map, center, zoom]);

  useMapEvents({
    moveend: () => {
      const mapCenter = map.getCenter();
      setCenter({ lat: mapCenter.lat, lng: mapCenter.lng });
    },
    zoomend: () => {
      setZoom(map.getZoom());
    },
  });

  return null;
}

// Component to load data when map moves
function DataLoader() {
  const map = useMap();
  const { showTraffic, showPOIs, loadTraffic, loadPOIs, loadIncidents, showIncidents } = useMapStore();
  const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const loadData = useCallback(() => {
    const bounds = map.getBounds();
    const boundsObj = {
      minLat: bounds.getSouth(),
      minLng: bounds.getWest(),
      maxLat: bounds.getNorth(),
      maxLng: bounds.getEast(),
    };

    if (showTraffic) {
      loadTraffic(boundsObj);
    }
    if (showPOIs) {
      loadPOIs(boundsObj);
    }
    if (showIncidents) {
      loadIncidents(boundsObj);
    }
  }, [map, showTraffic, showPOIs, showIncidents, loadTraffic, loadPOIs, loadIncidents]);

  useEffect(() => {
    loadData();
  }, [showTraffic, showPOIs, showIncidents, loadData]);

  useMapEvents({
    moveend: () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      loadTimeoutRef.current = setTimeout(loadData, 300);
    },
  });

  return null;
}

// Traffic layer component
function TrafficLayer() {
  const { trafficData, showTraffic } = useMapStore();

  if (!showTraffic) return null;

  const getTrafficColor = (congestion: string): string => {
    switch (congestion) {
      case 'free': return '#34C759';
      case 'light': return '#FFCC00';
      case 'moderate': return '#FF9500';
      case 'heavy': return '#FF3B30';
      default: return '#86868B';
    }
  };

  return (
    <>
      {trafficData.map((traffic: TrafficData) => {
        if (!traffic.geometry?.coordinates) return null;

        const positions = traffic.geometry.coordinates.map(
          (coord: number[]) => [coord[1], coord[0]] as [number, number]
        );

        return (
          <Polyline
            key={traffic.segmentId}
            positions={positions}
            pathOptions={{
              color: getTrafficColor(traffic.congestion),
              weight: 4,
              opacity: 0.8,
            }}
          />
        );
      })}
    </>
  );
}

// Route layer component
function RouteLayer() {
  const { route } = useMapStore();

  if (!route) return null;

  const positions = route.coordinates.map(
    (coord) => [coord.lat, coord.lng] as [number, number]
  );

  return (
    <Polyline
      positions={positions}
      pathOptions={{
        color: '#007AFF',
        weight: 6,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round',
      }}
    />
  );
}

// POI markers component
function POIMarkers() {
  const { pois, showPOIs, setSelectedPlace, setDestination } = useMapStore();

  if (!showPOIs) return null;

  return (
    <>
      {pois.map((poi: Place) => (
        <Marker
          key={poi.id}
          position={[poi.location.lat, poi.location.lng]}
          icon={poiIcons[poi.category] || poiIcons.default}
          eventHandlers={{
            click: () => {
              setSelectedPlace(poi);
            },
          }}
        >
          <Popup>
            <div className="min-w-48">
              <h3 className="font-semibold text-lg">{poi.name}</h3>
              <p className="text-sm text-gray-500 capitalize">{poi.category}</p>
              {poi.rating && (
                <p className="text-sm">
                  <span className="text-yellow-500">★</span> {poi.rating.toFixed(1)}
                </p>
              )}
              {poi.address && (
                <p className="text-xs text-gray-400 mt-1">{poi.address}</p>
              )}
              <button
                onClick={() => setDestination(poi.location)}
                className="mt-2 w-full bg-apple-blue text-white px-3 py-1 rounded-lg text-sm"
              >
                Directions
              </button>
            </div>
          </Popup>
        </Marker>
      ))}
    </>
  );
}

// Incident markers component
function IncidentMarkers() {
  const { incidents, showIncidents } = useMapStore();

  if (!showIncidents) return null;

  const getIncidentColor = (type: string): string => {
    switch (type) {
      case 'accident': return '#FF3B30';
      case 'construction': return '#FF9500';
      case 'closure': return '#FF3B30';
      case 'hazard': return '#FFCC00';
      default: return '#86868B';
    }
  };

  const getIncidentIcon = (type: string): string => {
    switch (type) {
      case 'accident': return '⚠️';
      case 'construction': return '🚧';
      case 'closure': return '🚫';
      case 'hazard': return '⚠️';
      default: return '❗';
    }
  };

  return (
    <>
      {incidents.map((incident) => (
        <CircleMarker
          key={incident.id}
          center={[incident.lat, incident.lng]}
          radius={10}
          pathOptions={{
            color: getIncidentColor(incident.type),
            fillColor: getIncidentColor(incident.type),
            fillOpacity: 0.8,
          }}
        >
          <Popup>
            <div className="min-w-40">
              <div className="flex items-center gap-2">
                <span className="text-xl">{getIncidentIcon(incident.type)}</span>
                <span className="font-semibold capitalize">{incident.type}</span>
              </div>
              {incident.description && (
                <p className="text-sm text-gray-600 mt-1">{incident.description}</p>
              )}
              <p className="text-xs text-gray-400 mt-1">
                Reported: {new Date(incident.reportedAt).toLocaleTimeString()}
              </p>
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </>
  );
}

// Origin and destination markers
function RouteMarkers() {
  const { origin, destination, setOrigin, setDestination } = useMapStore();

  return (
    <>
      {origin && (
        <Marker
          position={[origin.lat, origin.lng]}
          icon={originIcon}
          draggable
          eventHandlers={{
            dragend: (e) => {
              const marker = e.target;
              const position = marker.getLatLng();
              setOrigin({ lat: position.lat, lng: position.lng });
            },
          }}
        >
          <Popup>
            <div className="text-center">
              <p className="font-semibold">Start</p>
              <p className="text-xs text-gray-500">
                {origin.lat.toFixed(5)}, {origin.lng.toFixed(5)}
              </p>
            </div>
          </Popup>
        </Marker>
      )}
      {destination && (
        <Marker
          position={[destination.lat, destination.lng]}
          icon={destinationIcon}
          draggable
          eventHandlers={{
            dragend: (e) => {
              const marker = e.target;
              const position = marker.getLatLng();
              setDestination({ lat: position.lat, lng: position.lng });
            },
          }}
        >
          <Popup>
            <div className="text-center">
              <p className="font-semibold">Destination</p>
              <p className="text-xs text-gray-500">
                {destination.lat.toFixed(5)}, {destination.lng.toFixed(5)}
              </p>
            </div>
          </Popup>
        </Marker>
      )}
    </>
  );
}

export default function MapView() {
  const { center, zoom } = useMapStore();

  return (
    <MapContainer
      center={[center.lat, center.lng]}
      zoom={zoom}
      className="h-full w-full"
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <MapViewController />
      <MapEventHandler />
      <DataLoader />

      <RouteLayer />
      <TrafficLayer />
      <POIMarkers />
      <IncidentMarkers />
      <RouteMarkers />
    </MapContainer>
  );
}
