export interface LatLng {
  lat: number;
  lng: number;
}

export interface Place {
  id: string;
  name: string;
  category: string;
  location: LatLng;
  address?: string;
  phone?: string;
  rating?: number;
  reviewCount?: number;
  distance?: number;
}

export interface RoadNode {
  id: number;
  lat: number;
  lng: number;
  isIntersection: boolean;
}

export interface RoadSegment {
  id: number;
  startNodeId: number;
  endNodeId: number;
  streetName: string;
  roadClass: string;
  length: number;
  freeFlowSpeed: number;
  isToll: boolean;
  isOneWay: boolean;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
}

export interface TrafficData {
  segmentId: number;
  streetName?: string;
  freeFlowSpeed: number;
  currentSpeed: number;
  congestion: 'free' | 'light' | 'moderate' | 'heavy';
  geometry?: GeoJSON.LineString;
}

export interface Incident {
  id: string;
  segmentId: number;
  type: 'accident' | 'construction' | 'closure' | 'hazard';
  severity: 'low' | 'moderate' | 'high';
  lat: number;
  lng: number;
  description?: string;
  reportedAt: string;
}

export interface Maneuver {
  type: 'depart' | 'arrive' | 'straight' | 'left' | 'right' | 'slight-left' | 'slight-right' | 'sharp-left' | 'sharp-right' | 'u-turn';
  instruction: string;
  distance: number;
  distanceFormatted?: string;
  location: LatLng;
  streetName?: string;
}

export interface Route {
  coordinates: LatLng[];
  distance: number;
  distanceFormatted: string;
  duration: number;
  durationFormatted: string;
  maneuvers: Maneuver[];
  edges: {
    id: number;
    streetName: string;
    length: number;
    roadClass: string;
  }[];
}

export interface NavigationState {
  isNavigating: boolean;
  currentManeuverIndex: number;
  distanceToNextManeuver: number;
  eta: Date | null;
}
