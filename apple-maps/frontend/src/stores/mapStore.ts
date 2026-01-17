import { create } from 'zustand';
import type { LatLng, Place, Route, Incident, TrafficData, NavigationState } from '../types';
import { api } from '../services/api';

interface MapState {
  // Map view
  center: LatLng;
  zoom: number;
  setCenter: (center: LatLng) => void;
  setZoom: (zoom: number) => void;

  // Markers
  origin: LatLng | null;
  destination: LatLng | null;
  setOrigin: (origin: LatLng | null) => void;
  setDestination: (destination: LatLng | null) => void;

  // Route
  route: Route | null;
  alternativeRoutes: Route[];
  isLoadingRoute: boolean;
  routeError: string | null;
  calculateRoute: () => Promise<void>;
  clearRoute: () => void;

  // Search
  searchQuery: string;
  searchResults: Place[];
  isSearching: boolean;
  setSearchQuery: (query: string) => void;
  search: (query: string, options?: { lat?: number; lng?: number }) => Promise<void>;
  clearSearch: () => void;

  // Selected place
  selectedPlace: Place | null;
  setSelectedPlace: (place: Place | null) => void;

  // Traffic
  trafficData: TrafficData[];
  showTraffic: boolean;
  toggleTraffic: () => void;
  loadTraffic: (bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number }) => Promise<void>;

  // Incidents
  incidents: Incident[];
  showIncidents: boolean;
  toggleIncidents: () => void;
  loadIncidents: (bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number }) => Promise<void>;

  // POIs
  pois: Place[];
  showPOIs: boolean;
  togglePOIs: () => void;
  loadPOIs: (bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number }) => Promise<void>;

  // Navigation
  navigation: NavigationState;
  startNavigation: () => void;
  stopNavigation: () => void;
  updateNavigation: (position: LatLng) => void;

  // Route options
  routeOptions: {
    avoidTolls: boolean;
    avoidHighways: boolean;
  };
  setRouteOptions: (options: Partial<{ avoidTolls: boolean; avoidHighways: boolean }>) => void;
}

// San Francisco coordinates
const DEFAULT_CENTER: LatLng = { lat: 37.7749, lng: -122.4194 };
const DEFAULT_ZOOM = 14;

export const useMapStore = create<MapState>((set, get) => ({
  // Map view
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),

  // Markers
  origin: null,
  destination: null,
  setOrigin: (origin) => set({ origin }),
  setDestination: (destination) => set({ destination }),

  // Route
  route: null,
  alternativeRoutes: [],
  isLoadingRoute: false,
  routeError: null,

  calculateRoute: async () => {
    const { origin, destination, routeOptions } = get();
    if (!origin || !destination) {
      set({ routeError: 'Please set both origin and destination' });
      return;
    }

    set({ isLoadingRoute: true, routeError: null });

    try {
      const route = await api.calculateRoute(origin, destination, routeOptions);
      set({ route, isLoadingRoute: false });
    } catch (error) {
      set({
        routeError: error instanceof Error ? error.message : 'Failed to calculate route',
        isLoadingRoute: false,
      });
    }
  },

  clearRoute: () => set({
    route: null,
    alternativeRoutes: [],
    routeError: null,
    navigation: {
      isNavigating: false,
      currentManeuverIndex: 0,
      distanceToNextManeuver: 0,
      eta: null,
    },
  }),

  // Search
  searchQuery: '',
  searchResults: [],
  isSearching: false,
  setSearchQuery: (searchQuery) => set({ searchQuery }),

  search: async (query, options) => {
    set({ isSearching: true, searchQuery: query });

    try {
      const results = await api.searchPlaces(query, {
        lat: options?.lat ?? get().center.lat,
        lng: options?.lng ?? get().center.lng,
        radius: 10000,
        limit: 20,
      });
      set({ searchResults: results, isSearching: false });
    } catch (error) {
      console.error('Search error:', error);
      set({ searchResults: [], isSearching: false });
    }
  },

  clearSearch: () => set({
    searchQuery: '',
    searchResults: [],
    selectedPlace: null,
  }),

  // Selected place
  selectedPlace: null,
  setSelectedPlace: (selectedPlace) => set({ selectedPlace }),

  // Traffic
  trafficData: [],
  showTraffic: false,
  toggleTraffic: () => set((state) => ({ showTraffic: !state.showTraffic })),

  loadTraffic: async (bounds) => {
    try {
      const trafficData = await api.getTraffic(bounds);
      set({ trafficData });
    } catch (error) {
      console.error('Failed to load traffic:', error);
    }
  },

  // Incidents
  incidents: [],
  showIncidents: true,
  toggleIncidents: () => set((state) => ({ showIncidents: !state.showIncidents })),

  loadIncidents: async (bounds) => {
    try {
      const incidents = await api.getIncidents(bounds);
      set({ incidents });
    } catch (error) {
      console.error('Failed to load incidents:', error);
    }
  },

  // POIs
  pois: [],
  showPOIs: true,
  togglePOIs: () => set((state) => ({ showPOIs: !state.showPOIs })),

  loadPOIs: async (bounds) => {
    try {
      const pois = await api.getPOIs(bounds);
      set({ pois });
    } catch (error) {
      console.error('Failed to load POIs:', error);
    }
  },

  // Navigation
  navigation: {
    isNavigating: false,
    currentManeuverIndex: 0,
    distanceToNextManeuver: 0,
    eta: null,
  },

  startNavigation: () => {
    const { route } = get();
    if (!route) return;

    const eta = new Date(Date.now() + route.duration * 1000);

    set({
      navigation: {
        isNavigating: true,
        currentManeuverIndex: 0,
        distanceToNextManeuver: route.maneuvers[0]?.distance ?? 0,
        eta,
      },
    });
  },

  stopNavigation: () => set({
    navigation: {
      isNavigating: false,
      currentManeuverIndex: 0,
      distanceToNextManeuver: 0,
      eta: null,
    },
  }),

  updateNavigation: (position: LatLng) => {
    const { route, navigation } = get();
    if (!route || !navigation.isNavigating) return;

    // Simple distance calculation (could be improved with actual route matching)
    const currentManeuver = route.maneuvers[navigation.currentManeuverIndex];
    if (!currentManeuver) return;

    const dx = position.lat - currentManeuver.location.lat;
    const dy = position.lng - currentManeuver.location.lng;
    const distance = Math.sqrt(dx * dx + dy * dy) * 111000; // Rough conversion to meters

    if (distance < 50) {
      // Reached current maneuver, move to next
      const nextIndex = navigation.currentManeuverIndex + 1;
      if (nextIndex >= route.maneuvers.length) {
        // Navigation complete
        set({
          navigation: {
            ...navigation,
            isNavigating: false,
          },
        });
      } else {
        set({
          navigation: {
            ...navigation,
            currentManeuverIndex: nextIndex,
            distanceToNextManeuver: route.maneuvers[nextIndex]?.distance ?? 0,
          },
        });
      }
    } else {
      set({
        navigation: {
          ...navigation,
          distanceToNextManeuver: distance,
        },
      });
    }
  },

  // Route options
  routeOptions: {
    avoidTolls: false,
    avoidHighways: false,
  },
  setRouteOptions: (options) => set((state) => ({
    routeOptions: { ...state.routeOptions, ...options },
  })),
}));
