export interface User {
  id: string;
  email: string;
  name: string;
  phone?: string;
  userType: 'rider' | 'driver';
  rating: number;
  ratingCount?: number;
  vehicle?: Vehicle;
  isAvailable?: boolean;
  isOnline?: boolean;
  totalRides?: number;
  totalEarningsCents?: number;
}

export interface Vehicle {
  vehicleType: 'economy' | 'comfort' | 'premium' | 'xl';
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  licensePlate: string;
}

export interface Location {
  lat: number;
  lng: number;
  address?: string;
}

export interface Driver {
  id: string;
  name: string;
  rating: number;
  vehicleType: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  licensePlate: string;
  location?: Location;
  distanceKm?: number;
  eta?: number;
}

export interface FareEstimate {
  vehicleType: string;
  baseFareCents: number;
  distanceFareCents: number;
  timeFareCents: number;
  vehicleMultiplier: number;
  surgeMultiplier: number;
  totalFareCents: number;
  distanceKm: number;
  distanceMiles: number;
  durationMinutes: number;
  availableDrivers?: number;
}

export interface Ride {
  id: string;
  status: RideStatus;
  pickup: Location;
  dropoff: Location;
  vehicleType: string;
  driver?: Driver;
  rider?: { name: string };
  fare?: {
    estimated: number;
    final?: number;
    surgeMultiplier: number;
  };
  fareEstimate?: FareEstimate;
  requestedAt?: string;
  completedAt?: string;
}

export type RideStatus =
  | 'requested'
  | 'matched'
  | 'driver_arrived'
  | 'picked_up'
  | 'completed'
  | 'cancelled';

export interface SurgeInfo {
  multiplier: number;
  demand: number;
  supply: number;
  isActive: boolean;
  message: string;
}

export interface EarningsData {
  period: string;
  totalRides: number;
  totalEarnings: number;
  averageFare: number;
  totalDistanceKm: number;
  totalHours: number;
  hourlyBreakdown: Array<{
    hour: string;
    rides: number;
    earnings: number;
  }>;
}

export interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

export interface RideOffer {
  type: 'ride_offer';
  rideId: string;
  rider: {
    name: string;
    rating: number;
  };
  pickup: Location;
  dropoff: Location;
  estimatedFare: number;
  distanceKm: number;
  etaMinutes: number;
  expiresIn: number;
}

export interface ApiError {
  error: string;
}
