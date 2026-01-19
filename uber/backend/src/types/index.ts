import type { Request } from 'express';
import type { WebSocket } from 'ws';
import type { Logger } from 'pino';

// User types
export type UserType = 'rider' | 'driver';

export interface VehicleInfo {
  vehicleType: VehicleType;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  licensePlate: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  userType: UserType;
  rating: number;
  ratingCount?: number;
  vehicle?: VehicleInfo | null;
  isAvailable?: boolean;
  isOnline?: boolean;
  totalRides?: number;
  totalEarningsCents?: number;
}

// Vehicle types
export type VehicleType = 'economy' | 'comfort' | 'premium' | 'xl';

export interface VehicleMultipliers {
  economy: number;
  comfort: number;
  premium: number;
  xl: number;
}

// Ride types
export type RideStatus =
  | 'requested'
  | 'matched'
  | 'driver_arrived'
  | 'picked_up'
  | 'completed'
  | 'cancelled';

export interface Location {
  lat: number;
  lng: number;
  address?: string | null;
}

export interface DriverLocation extends Location {
  timestamp: number;
  source: 'redis' | 'postgres';
}

export interface RideData {
  riderId: string;
  status: string;
  pickupLat: string;
  pickupLng: string;
  dropoffLat: string;
  dropoffLng: string;
  vehicleType: VehicleType;
  createdAt: string;
  driverId?: string;
}

export interface Ride {
  id: string;
  status: RideStatus;
  pickup: Location;
  dropoff: Location;
  driver?: DriverInfo | null;
  fare?: FareInfo;
  driverId?: string | null;
  driverLocation?: DriverLocation | null;
}

export interface DriverInfo {
  id: string;
  name: string;
  rating?: number;
  ratingCount?: number;
  vehicleType: VehicleType;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  licensePlate: string;
  location?: DriverLocation | null;
}

export interface NearbyDriver {
  id: string;
  name: string;
  rating: number;
  ratingCount: number;
  vehicleType: VehicleType;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  licensePlate: string;
  lat: number;
  lng: number;
  distanceKm: number;
}

export interface ScoredDriver extends NearbyDriver {
  eta: number;
  score: number;
}

// Fare types
export interface FareEstimate {
  baseFareCents: number;
  distanceFareCents: number;
  timeFareCents: number;
  vehicleMultiplier: number;
  surgeMultiplier: number;
  totalFareCents: number;
  distanceKm: number;
  distanceMiles: number;
  durationMinutes: number;
  vehicleType?: VehicleType;
  availableDrivers?: number;
}

export interface FareInfo {
  estimated: number;
  final: number | null;
  surgeMultiplier: number;
}

export interface SurgeInfo {
  multiplier: number;
  demand: number;
  supply: number;
  isActive: boolean;
  message: string;
}

// Auth types
export interface AuthResult {
  success: boolean;
  error?: string;
  user?: User;
  token?: string;
}

export interface SessionUser extends User {
  token?: string;
}

// Request extension
export interface AuthenticatedRequest extends Request {
  user: User;
  token: string;
  requestId?: string;
  log?: Logger;
}

// WebSocket message types
export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export interface WSAuthMessage extends WSMessage {
  type: 'auth';
  token: string;
}

export interface WSLocationMessage extends WSMessage {
  type: 'location_update';
  lat: number;
  lng: number;
}

export interface WSRideOffer {
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

// Queue message types
export interface MatchingRequest {
  requestId: string;
  rideId: string;
  pickupLocation: { lat: number; lng: number };
  dropoffLocation: { lat: number; lng: number };
  vehicleType: VehicleType;
  maxWaitSeconds?: number;
  attempt: number;
  riderId?: string;
}

export interface RideEvent {
  eventId: string;
  eventType: string;
  rideId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

// Health types
export interface ServiceHealth {
  status: 'healthy' | 'unhealthy' | 'degraded';
  latency: number;
  error?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  uptime: number;
  version: string;
  totalLatency: number;
  services: {
    postgres: ServiceHealth;
    redis: ServiceHealth;
    rabbitmq: ServiceHealth;
  };
  circuitBreakers: Record<string, CircuitBreakerStatus>;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
}

export interface CircuitBreakerStatus {
  state: 'open' | 'closed' | 'half-open';
  stats: {
    successes: number;
    failures: number;
    rejects: number;
    timeouts: number;
    fallbacks: number;
  };
}

export interface LivenessStatus {
  status: 'ok';
  timestamp: string;
}

export interface ReadinessStatus {
  ready: boolean;
  timestamp: string;
  checks: {
    postgres: string;
    redis: string;
  };
}

// Config types
export interface Config {
  port: number;
  nodeEnv: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  rabbitmq: {
    url: string;
  };
  session: {
    secret: string;
    expiresIn: number;
  };
  pricing: {
    baseFareCents: number;
    perMileCents: number;
    perMinuteCents: number;
    minimumFareCents: number;
    vehicleMultipliers: VehicleMultipliers;
  };
  matching: {
    searchRadiusKm: number;
    maxSearchRadiusKm: number;
    matchingTimeoutSeconds: number;
  };
  location: {
    updateIntervalMs: number;
    staleThresholdMs: number;
  };
  circuitBreaker: {
    timeout: number;
    errorThresholdPercentage: number;
    resetTimeout: number;
    volumeThreshold: number;
  };
  idempotency: {
    defaultTtl: number;
    pendingTtl: number;
  };
}

// Database row types
export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  phone: string | null;
  user_type: UserType;
  rating: string;
  rating_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface DriverRow extends UserRow {
  vehicle_type: VehicleType;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  license_plate: string;
  is_available: boolean;
  is_online: boolean;
  current_lat: string | null;
  current_lng: string | null;
  total_rides: number;
  total_earnings_cents: number;
}

export interface RideRow {
  id: string;
  rider_id: string;
  driver_id: string | null;
  status: RideStatus;
  pickup_lat: string;
  pickup_lng: string;
  pickup_address: string | null;
  dropoff_lat: string;
  dropoff_lng: string;
  dropoff_address: string | null;
  vehicle_type: VehicleType;
  estimated_fare_cents: number;
  final_fare_cents: number | null;
  surge_multiplier: string;
  distance_meters: number;
  duration_seconds: number | null;
  driver_rating: number | null;
  rider_rating: number | null;
  requested_at: Date;
  matched_at: Date | null;
  driver_arrived_at: Date | null;
  picked_up_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
}

export interface RideRowWithDriver extends RideRow {
  driver_name?: string;
  rider_name?: string;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_color?: string;
}

// Idempotency types
export interface IdempotentResponse {
  statusCode: number;
  body: unknown;
  cachedAt: number;
}
