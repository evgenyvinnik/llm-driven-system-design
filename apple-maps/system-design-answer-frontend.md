# Apple Maps - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design Apple Maps from a frontend perspective, focusing on the map rendering experience, route visualization, turn-by-turn navigation UI, and search interactions. The key challenges are rendering smooth, interactive maps with vector tiles, displaying real-time traffic overlays, and providing an intuitive navigation experience that works across devices.

As a frontend engineer, I'll emphasize the map component architecture, WebGL-based tile rendering, gesture handling for map interactions, and the state management needed to coordinate navigation with real-time updates."

## Requirements Clarification (3 minutes)

### Functional Requirements (Frontend Scope)
- **Map Display**: Render interactive maps with pan, zoom, and rotation
- **Route Visualization**: Display calculated routes with turn indicators
- **Navigation UI**: Turn-by-turn guidance with distance and ETA
- **Traffic Overlay**: Color-coded traffic conditions on roads
- **Search**: Place search with autocomplete and recent history
- **POI Display**: Show points of interest with category icons

### Non-Functional Requirements
- **Performance**: 60 FPS map interactions on mid-range devices
- **Responsiveness**: Instant feedback on touch/click events
- **Offline**: Display cached tiles when network unavailable
- **Accessibility**: Screen reader support for navigation instructions

### User Experience Goals
- Intuitive map gestures (pinch-to-zoom, two-finger rotate)
- Clear visual hierarchy for navigation instructions
- Smooth animations during route following
- Responsive layout for mobile and desktop

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              React Application                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────────┐  │
│  │   SearchBar     │  │  RoutePanel     │  │        MapContainer             │  │
│  │                 │  │                 │  │                                 │  │
│  │ - Autocomplete  │  │ - Route list    │  │  ┌─────────────────────────┐   │  │
│  │ - Recent places │  │ - Alternatives  │  │  │      MapRenderer        │   │  │
│  │ - POI filters   │  │ - Route details │  │  │   (Leaflet/MapLibre)    │   │  │
│  └─────────────────┘  └─────────────────┘  │  │                         │   │  │
│                                             │  │  - Vector tiles         │   │  │
│  ┌─────────────────────────────────────┐   │  │  - Traffic overlay      │   │  │
│  │         NavigationPanel             │   │  │  - Route polyline       │   │  │
│  │                                     │   │  │  - POI markers          │   │  │
│  │  ┌───────────┐  ┌───────────────┐   │   │  └─────────────────────────┘   │  │
│  │  │ Maneuver  │  │   ETADisplay  │   │   │                                 │  │
│  │  │   Card    │  │               │   │   └─────────────────────────────────┘  │
│  │  └───────────┘  └───────────────┘   │                                        │
│  │                                     │                                        │
│  │  ┌───────────────────────────────┐  │                                        │
│  │  │     ProgressBar               │  │                                        │
│  │  └───────────────────────────────┘  │                                        │
│  └─────────────────────────────────────┘                                        │
│                                                                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                              State Management (Zustand)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ mapStore     │  │ routeStore   │  │ searchStore  │  │ navigationStore      │ │
│  │ - viewport   │  │ - routes     │  │ - query      │  │ - currentManeuver    │ │
│  │ - zoom       │  │ - selected   │  │ - results    │  │ - progress           │ │
│  │ - rotation   │  │ - traffic    │  │ - recent     │  │ - eta                │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Map Rendering (10 minutes)

### MapContainer Component

```tsx
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { useMapStore } from '../stores/mapStore';

export function MapView() {
  const { center, zoom, rotation } = useMapStore();

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      className="h-full w-full"
      zoomControl={false}
      attributionControl={false}
    >
      {/* Vector tile layer from MapTiler or self-hosted */}
      <VectorTileLayer
        url="https://tiles.example.com/{z}/{x}/{y}.pbf"
        style={mapStyle}
      />

      {/* Traffic overlay layer */}
      <TrafficOverlay />

      {/* Route polyline when navigating */}
      <RoutePolyline />

      {/* POI markers */}
      <POIMarkers />

      {/* Current position marker */}
      <CurrentPositionMarker />

      {/* Map event handlers */}
      <MapEventHandler />
    </MapContainer>
  );
}
```

### Vector Tile Layer with WebGL

For production performance, we use MapLibre GL for WebGL-accelerated rendering:

```tsx
import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { useMapStore } from '../stores/mapStore';

export function MapLibreRenderer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const { center, zoom, setViewport } = useMapStore();

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'vector',
            tiles: ['https://tiles.example.com/{z}/{x}/{y}.pbf'],
            maxzoom: 18,
          },
        },
        layers: [
          // Base road layer
          {
            id: 'roads',
            type: 'line',
            source: 'osm-tiles',
            'source-layer': 'roads',
            paint: {
              'line-color': [
                'match',
                ['get', 'road_class'],
                'highway', '#FFA500',
                'arterial', '#FFFFFF',
                'local', '#CCCCCC',
                '#AAAAAA',
              ],
              'line-width': [
                'interpolate',
                ['linear'],
                ['zoom'],
                10, 1,
                14, 3,
                18, 8,
              ],
            },
          },
          // Buildings at high zoom
          {
            id: 'buildings',
            type: 'fill-extrusion',
            source: 'osm-tiles',
            'source-layer': 'buildings',
            minzoom: 15,
            paint: {
              'fill-extrusion-color': '#DDDDDD',
              'fill-extrusion-height': ['get', 'height'],
              'fill-extrusion-opacity': 0.8,
            },
          },
        ],
      },
      center: [center.lng, center.lat],
      zoom,
      maxZoom: 18,
      minZoom: 3,
    });

    // Gesture handling
    map.on('moveend', () => {
      const center = map.getCenter();
      setViewport({
        center: { lat: center.lat, lng: center.lng },
        zoom: map.getZoom(),
        bearing: map.getBearing(),
      });
    });

    mapRef.current = map;

    return () => map.remove();
  }, []);

  // Update map when store changes
  useEffect(() => {
    if (!mapRef.current) return;

    mapRef.current.easeTo({
      center: [center.lng, center.lat],
      zoom,
      duration: 300,
    });
  }, [center, zoom]);

  return <div ref={containerRef} className="h-full w-full" />;
}
```

### Traffic Overlay Component

```tsx
import { useQuery } from '@tanstack/react-query';
import { Source, Layer } from 'react-map-gl';
import { useMapStore } from '../stores/mapStore';
import { fetchTrafficData } from '../api/traffic';

export function TrafficOverlay() {
  const { bounds } = useMapStore();

  // Fetch traffic data for visible area
  const { data: trafficData } = useQuery({
    queryKey: ['traffic', bounds],
    queryFn: () => fetchTrafficData(bounds),
    refetchInterval: 30000, // Refresh every 30 seconds
    staleTime: 15000,
  });

  if (!trafficData) return null;

  // Convert traffic data to GeoJSON
  const trafficGeoJSON = {
    type: 'FeatureCollection' as const,
    features: trafficData.segments.map(segment => ({
      type: 'Feature' as const,
      geometry: segment.geometry,
      properties: {
        congestionLevel: segment.congestionLevel,
        speedRatio: segment.speed / segment.freeFlowSpeed,
      },
    })),
  };

  return (
    <Source id="traffic" type="geojson" data={trafficGeoJSON}>
      <Layer
        id="traffic-layer"
        type="line"
        paint={{
          'line-color': [
            'match',
            ['get', 'congestionLevel'],
            'free', '#00CC00',
            'light', '#FFCC00',
            'moderate', '#FF6600',
            'heavy', '#CC0000',
            '#888888',
          ],
          'line-width': 4,
          'line-opacity': 0.8,
        }}
      />
    </Source>
  );
}
```

### Gesture Handling for Map Interactions

```tsx
import { useGesture } from '@use-gesture/react';
import { useMapStore } from '../stores/mapStore';

export function MapGestureHandler({ children }: { children: React.ReactNode }) {
  const { setViewport, zoom, center } = useMapStore();
  const containerRef = useRef<HTMLDivElement>(null);

  const bind = useGesture(
    {
      // Pinch to zoom
      onPinch: ({ offset: [scale], origin: [ox, oy] }) => {
        const newZoom = Math.max(3, Math.min(18, zoom + Math.log2(scale)));
        setViewport({ zoom: newZoom });
      },

      // Two-finger rotate
      onRotate: ({ offset: [angle] }) => {
        setViewport({ bearing: angle });
      },

      // Drag to pan
      onDrag: ({ movement: [mx, my], pinching }) => {
        if (pinching) return; // Ignore drag during pinch

        const metersPerPixel = 156543.03 * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, zoom);
        const deltaLng = -mx * metersPerPixel / 111320;
        const deltaLat = my * metersPerPixel / 110540;

        setViewport({
          center: {
            lat: center.lat + deltaLat,
            lng: center.lng + deltaLng,
          },
        });
      },

      // Double-tap to zoom in
      onDoubleClick: ({ event }) => {
        event.preventDefault();
        setViewport({ zoom: Math.min(18, zoom + 1) });
      },
    },
    {
      target: containerRef,
      eventOptions: { passive: false },
    }
  );

  return (
    <div ref={containerRef} className="h-full w-full touch-none">
      {children}
    </div>
  );
}
```

## Deep Dive: Navigation UI (10 minutes)

### NavigationPanel Component

```tsx
import { useNavigationStore } from '../stores/navigationStore';
import { ManeuverCard } from './ManeuverCard';
import { ETADisplay } from './ETADisplay';
import { RouteProgress } from './RouteProgress';

export function NavigationPanel() {
  const {
    isNavigating,
    currentManeuver,
    nextManeuver,
    distanceToManeuver,
    eta,
    progress,
    remainingDistance,
    remainingTime,
  } = useNavigationStore();

  if (!isNavigating) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-white shadow-lg">
      {/* Current maneuver - large and prominent */}
      <ManeuverCard
        maneuver={currentManeuver}
        distance={distanceToManeuver}
        variant="current"
      />

      {/* Next maneuver - smaller preview */}
      {nextManeuver && (
        <ManeuverCard
          maneuver={nextManeuver}
          distance={currentManeuver.distance}
          variant="next"
        />
      )}

      {/* ETA and remaining distance */}
      <div className="flex justify-between px-4 py-2 bg-gray-100">
        <ETADisplay eta={eta} />
        <div className="text-right">
          <div className="text-lg font-semibold">
            {formatDistance(remainingDistance)}
          </div>
          <div className="text-sm text-gray-500">
            {formatDuration(remainingTime)}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <RouteProgress progress={progress} />
    </div>
  );
}
```

### ManeuverCard Component

```tsx
import { Maneuver } from '../types';
import { TurnIcon } from './icons/TurnIcon';
import { formatDistance } from '../utils/format';

interface ManeuverCardProps {
  maneuver: Maneuver;
  distance: number;
  variant: 'current' | 'next';
}

export function ManeuverCard({ maneuver, distance, variant }: ManeuverCardProps) {
  const isCurrent = variant === 'current';

  return (
    <div
      className={cn(
        'flex items-center gap-4 p-4',
        isCurrent ? 'bg-blue-600 text-white' : 'bg-gray-50 text-gray-700'
      )}
      role="region"
      aria-label={`${isCurrent ? 'Current' : 'Next'} navigation instruction`}
    >
      {/* Turn icon */}
      <div className={cn(
        'flex-shrink-0',
        isCurrent ? 'w-16 h-16' : 'w-10 h-10'
      )}>
        <TurnIcon
          type={maneuver.type}
          className={isCurrent ? 'text-white' : 'text-blue-600'}
        />
      </div>

      {/* Instruction text */}
      <div className="flex-1 min-w-0">
        <div className={cn(
          'font-semibold truncate',
          isCurrent ? 'text-xl' : 'text-sm'
        )}>
          {maneuver.instruction}
        </div>
        {maneuver.streetName && (
          <div className={cn(
            'truncate',
            isCurrent ? 'text-blue-100' : 'text-gray-500'
          )}>
            {maneuver.streetName}
          </div>
        )}
      </div>

      {/* Distance to maneuver */}
      <div className={cn(
        'text-right flex-shrink-0',
        isCurrent ? 'text-2xl font-bold' : 'text-sm'
      )}>
        {formatDistance(distance)}
      </div>
    </div>
  );
}
```

### TurnIcon Component

```tsx
interface TurnIconProps {
  type: string;
  className?: string;
}

export function TurnIcon({ type, className }: TurnIconProps) {
  const iconPath = getTurnIconPath(type);

  return (
    <svg
      viewBox="0 0 48 48"
      className={cn('w-full h-full', className)}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={iconPath} />
    </svg>
  );
}

function getTurnIconPath(type: string): string {
  switch (type) {
    case 'straight':
      return 'M24 4 L24 44 M16 12 L24 4 L32 12';
    case 'slight-right':
      return 'M24 44 L24 20 L36 8 M30 16 L36 8 L28 6';
    case 'right':
      return 'M24 44 L24 24 L44 24 M36 16 L44 24 L36 32';
    case 'sharp-right':
      return 'M24 44 L24 24 L40 40 M32 34 L40 40 L34 32';
    case 'u-turn':
      return 'M16 44 L16 20 A12 12 0 0 1 40 20 L40 28 M32 20 L40 28 L48 20';
    case 'slight-left':
      return 'M24 44 L24 20 L12 8 M18 16 L12 8 L20 6';
    case 'left':
      return 'M24 44 L24 24 L4 24 M12 16 L4 24 L12 32';
    case 'sharp-left':
      return 'M24 44 L24 24 L8 40 M16 34 L8 40 L14 32';
    case 'arrive':
      return 'M24 8 L24 28 M24 36 L24 36 M18 34 L24 40 L30 34';
    default:
      return 'M24 4 L24 44';
  }
}
```

### Real-Time Position Tracking

```tsx
import { useEffect, useCallback } from 'react';
import { useNavigationStore } from '../stores/navigationStore';
import { useMapStore } from '../stores/mapStore';

export function usePositionTracking() {
  const { isNavigating, updatePosition } = useNavigationStore();
  const { setCenter, setRotation } = useMapStore();

  const handlePosition = useCallback(
    (position: GeolocationPosition) => {
      const { latitude, longitude, heading, speed } = position.coords;

      // Update navigation state
      updatePosition({
        lat: latitude,
        lng: longitude,
        heading: heading ?? 0,
        speed: speed ?? 0,
        timestamp: position.timestamp,
      });

      // Center map on current position during navigation
      if (isNavigating) {
        setCenter({ lat: latitude, lng: longitude });

        // Rotate map to match heading (north-up vs. heading-up mode)
        if (heading !== null) {
          setRotation(-heading);
        }
      }
    },
    [isNavigating, updatePosition, setCenter, setRotation]
  );

  useEffect(() => {
    if (!navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      handlePosition,
      (error) => {
        console.error('Geolocation error:', error);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 5000,
      }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [handlePosition]);
}
```

## Deep Dive: Search Experience (5 minutes)

### SearchBar with Autocomplete

```tsx
import { useState, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDebounce } from '../hooks/useDebounce';
import { searchPlaces } from '../api/search';
import { useSearchStore } from '../stores/searchStore';

export function SearchBar() {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const { addToRecent, recentSearches } = useSearchStore();

  // Debounce search query
  const debouncedQuery = useDebounce(query, 200);

  // Fetch search results
  const { data: results, isLoading } = useQuery({
    queryKey: ['places', debouncedQuery],
    queryFn: () => searchPlaces(debouncedQuery),
    enabled: debouncedQuery.length >= 2,
    staleTime: 60000,
  });

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const items = results || [];

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex(i => Math.min(i + 1, items.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex(i => Math.max(i - 1, -1));
          break;
        case 'Enter':
          if (activeIndex >= 0 && items[activeIndex]) {
            handleSelect(items[activeIndex]);
          }
          break;
        case 'Escape':
          setIsOpen(false);
          inputRef.current?.blur();
          break;
      }
    },
    [results, activeIndex]
  );

  const handleSelect = (place: Place) => {
    addToRecent(place);
    setQuery(place.name);
    setIsOpen(false);
    // Navigate to place or start routing
  };

  return (
    <div className="relative w-full max-w-md">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search for a place"
          className="w-full pl-10 pr-4 py-3 rounded-full border border-gray-300
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          aria-label="Search for a place"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-activedescendant={
            activeIndex >= 0 ? `result-${activeIndex}` : undefined
          }
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            aria-label="Clear search"
          >
            <XIcon className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Dropdown results */}
      {isOpen && (
        <div
          className="absolute top-full left-0 right-0 mt-2 bg-white rounded-lg shadow-lg
                      border border-gray-200 max-h-80 overflow-y-auto z-50"
          role="listbox"
        >
          {/* Recent searches when empty */}
          {!query && recentSearches.length > 0 && (
            <div className="p-2">
              <div className="text-xs font-medium text-gray-500 px-2 py-1">
                Recent
              </div>
              {recentSearches.slice(0, 5).map((place, index) => (
                <SearchResultItem
                  key={place.id}
                  place={place}
                  isActive={activeIndex === index}
                  onClick={() => handleSelect(place)}
                  icon={<ClockIcon className="w-4 h-4" />}
                />
              ))}
            </div>
          )}

          {/* Search results */}
          {isLoading && (
            <div className="p-4 text-center text-gray-500">
              <LoadingSpinner className="w-5 h-5 mx-auto" />
            </div>
          )}

          {results?.map((place, index) => (
            <SearchResultItem
              key={place.id}
              id={`result-${index}`}
              place={place}
              isActive={activeIndex === index}
              onClick={() => handleSelect(place)}
              icon={<CategoryIcon category={place.category} />}
            />
          ))}

          {query && !isLoading && results?.length === 0 && (
            <div className="p-4 text-center text-gray-500">
              No results found
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

### SearchResultItem Component

```tsx
interface SearchResultItemProps {
  place: Place;
  isActive: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  id?: string;
}

function SearchResultItem({
  place,
  isActive,
  onClick,
  icon,
  id,
}: SearchResultItemProps) {
  return (
    <button
      id={id}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50',
        isActive && 'bg-blue-50'
      )}
      role="option"
      aria-selected={isActive}
    >
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100
                      flex items-center justify-center text-gray-500">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{place.name}</div>
        <div className="text-sm text-gray-500 truncate">{place.address}</div>
      </div>
      {place.distance && (
        <div className="text-sm text-gray-400">
          {formatDistance(place.distance)}
        </div>
      )}
    </button>
  );
}
```

## Deep Dive: Route Panel (5 minutes)

### RoutePanel with Alternatives

```tsx
import { useQuery, useMutation } from '@tanstack/react-query';
import { useRouteStore } from '../stores/routeStore';
import { fetchRoute } from '../api/routing';
import { RouteCard } from './RouteCard';

export function RoutePanel() {
  const {
    origin,
    destination,
    selectedRouteId,
    setSelectedRoute,
    routeOptions,
  } = useRouteStore();

  const { data: routeData, isLoading } = useQuery({
    queryKey: ['route', origin, destination, routeOptions],
    queryFn: () =>
      fetchRoute({
        origin,
        destination,
        options: routeOptions,
      }),
    enabled: !!origin && !!destination,
  });

  if (!origin || !destination) {
    return <RoutePlaceholder />;
  }

  if (isLoading) {
    return <RouteLoadingSkeleton />;
  }

  const { primaryRoute, alternatives } = routeData || {};
  const allRoutes = [primaryRoute, ...alternatives].filter(Boolean);

  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden">
      {/* Route options */}
      <div className="flex gap-2 p-3 border-b border-gray-100">
        <RouteOptionToggle
          label="Tolls"
          isActive={!routeOptions.avoidTolls}
          onToggle={() => toggleOption('avoidTolls')}
        />
        <RouteOptionToggle
          label="Highways"
          isActive={!routeOptions.avoidHighways}
          onToggle={() => toggleOption('avoidHighways')}
        />
      </div>

      {/* Route list */}
      <div className="divide-y divide-gray-100">
        {allRoutes.map((route, index) => (
          <RouteCard
            key={route.id}
            route={route}
            isSelected={route.id === selectedRouteId}
            isPrimary={index === 0}
            onSelect={() => setSelectedRoute(route.id)}
          />
        ))}
      </div>

      {/* Start navigation button */}
      <div className="p-3">
        <button
          onClick={() => startNavigation(selectedRouteId)}
          className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold
                     hover:bg-blue-700 transition-colors"
        >
          Start Navigation
        </button>
      </div>
    </div>
  );
}
```

### RouteCard Component

```tsx
interface RouteCardProps {
  route: Route;
  isSelected: boolean;
  isPrimary: boolean;
  onSelect: () => void;
}

export function RouteCard({
  route,
  isSelected,
  isPrimary,
  onSelect,
}: RouteCardProps) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full p-4 text-left transition-colors',
        isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
      )}
    >
      <div className="flex items-center gap-3">
        {/* Route indicator */}
        <div
          className={cn(
            'w-3 h-3 rounded-full',
            isPrimary ? 'bg-blue-600' : 'bg-gray-400'
          )}
        />

        {/* Route details */}
        <div className="flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold">
              {formatDuration(route.duration)}
            </span>
            {route.trafficDelay > 0 && (
              <span className="text-sm text-red-500">
                +{formatDuration(route.trafficDelay)} traffic
              </span>
            )}
          </div>
          <div className="text-sm text-gray-500">
            {formatDistance(route.distance)} via {route.viaStreet}
          </div>
        </div>

        {/* Selection indicator */}
        {isSelected && (
          <CheckIcon className="w-5 h-5 text-blue-600" />
        )}
      </div>

      {/* Route summary badges */}
      <div className="flex gap-2 mt-2 ml-6">
        {route.hasTolls && (
          <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded">
            Tolls
          </span>
        )}
        {route.hasHighways && (
          <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded">
            Highway
          </span>
        )}
        {route.hasIncidents && (
          <span className="text-xs px-2 py-0.5 bg-red-100 text-red-800 rounded">
            Incident
          </span>
        )}
      </div>
    </button>
  );
}
```

## Trade-offs and Alternatives (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Map library | MapLibre GL | Leaflet | WebGL for 60 FPS; 3D buildings; smooth rotation |
| Tile format | Vector | Raster | Smaller downloads; client-side styling; dark mode |
| State management | Zustand | Redux | Simpler API; less boilerplate; good TypeScript support |
| Gesture handling | @use-gesture/react | Native events | Multi-touch support; pinch-zoom-rotate; momentum |
| Search debounce | 200ms | Immediate | Balance responsiveness vs. API calls |
| Position tracking | watchPosition | Polling | Native API; battery efficient; heading support |

## Accessibility Considerations

1. **Screen reader support**: All maneuvers announced with ARIA live regions
2. **Keyboard navigation**: Full search and route selection without mouse
3. **Color contrast**: Traffic colors meet WCAG AA standards
4. **Focus management**: Logical tab order through navigation flow
5. **Reduced motion**: Respect `prefers-reduced-motion` for animations

## Closing Summary (1 minute)

"The Apple Maps frontend is built around three core experiences:

1. **WebGL Map Rendering** - Using MapLibre GL for 60 FPS interactions, vector tile styling, and 3D building visualization. Gesture handling supports pinch-zoom, rotation, and smooth panning.

2. **Intuitive Navigation UI** - Large, clear maneuver cards with turn icons, real-time ETA updates, and progress tracking. The UI adapts between planning mode and active navigation.

3. **Responsive Search** - Debounced autocomplete with keyboard navigation, recent search history, and category filtering. Results show distance and category icons for quick scanning.

The main trade-off is complexity vs. performance. Vector tiles require more client processing but enable dynamic styling, dark mode, and smooth rotation - essential for a premium map experience."

## Future Enhancements (Frontend)

1. **Offline Maps**: IndexedDB tile caching with Service Worker
2. **3D Navigation**: Realistic building flyovers for complex interchanges
3. **AR Walking Directions**: Camera overlay for pedestrian navigation
4. **Voice Guidance**: Web Speech API for turn-by-turn audio
5. **CarPlay Integration**: Simplified UI for automotive displays
