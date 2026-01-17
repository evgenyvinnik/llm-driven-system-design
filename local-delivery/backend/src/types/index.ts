// User types
export interface User {
  id: string;
  email: string;
  password_hash?: string;
  name: string;
  phone: string | null;
  role: 'customer' | 'driver' | 'merchant' | 'admin';
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
  phone?: string;
  role: 'customer' | 'driver' | 'merchant' | 'admin';
}

// Driver types
export interface Driver {
  id: string;
  vehicle_type: 'bicycle' | 'motorcycle' | 'car' | 'van';
  license_plate: string | null;
  status: 'offline' | 'available' | 'busy';
  rating: number;
  total_deliveries: number;
  acceptance_rate: number;
  current_lat: number | null;
  current_lng: number | null;
  location_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DriverWithDistance extends Driver {
  distance: number;
  name: string;
}

export interface CreateDriverInput {
  user_id: string;
  vehicle_type: 'bicycle' | 'motorcycle' | 'car' | 'van';
  license_plate?: string;
}

// Merchant types
export interface Merchant {
  id: string;
  owner_id: string | null;
  name: string;
  description: string | null;
  address: string;
  lat: number;
  lng: number;
  category: string;
  avg_prep_time_minutes: number;
  rating: number;
  is_open: boolean;
  opens_at: string;
  closes_at: string;
  created_at: Date;
  updated_at: Date;
}

export interface MerchantWithDistance extends Merchant {
  distance: number;
}

// Menu item types
export interface MenuItem {
  id: string;
  merchant_id: string;
  name: string;
  description: string | null;
  price: number;
  category: string | null;
  image_url: string | null;
  is_available: boolean;
  created_at: Date;
  updated_at: Date;
}

// Order types
export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready_for_pickup'
  | 'driver_assigned'
  | 'picked_up'
  | 'in_transit'
  | 'delivered'
  | 'cancelled';

export interface Order {
  id: string;
  customer_id: string | null;
  merchant_id: string | null;
  driver_id: string | null;
  status: OrderStatus;
  delivery_address: string;
  delivery_lat: number;
  delivery_lng: number;
  delivery_instructions: string | null;
  subtotal: number;
  delivery_fee: number;
  tip: number;
  total: number;
  estimated_prep_time_minutes: number | null;
  estimated_delivery_time: Date | null;
  actual_delivery_time: Date | null;
  created_at: Date;
  confirmed_at: Date | null;
  picked_up_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  updated_at: Date;
}

export interface OrderWithDetails extends Order {
  items: OrderItem[];
  merchant?: Merchant;
  driver?: Driver & { name: string };
  customer?: { name: string; phone: string | null };
}

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  name: string;
  quantity: number;
  unit_price: number;
  special_instructions: string | null;
  created_at: Date;
}

export interface CreateOrderInput {
  merchant_id: string;
  delivery_address: string;
  delivery_lat: number;
  delivery_lng: number;
  delivery_instructions?: string;
  items: {
    menu_item_id: string;
    quantity: number;
    special_instructions?: string;
  }[];
  tip?: number;
}

// Driver offer types
export interface DriverOffer {
  id: string;
  order_id: string;
  driver_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  offered_at: Date;
  expires_at: Date;
  responded_at: Date | null;
}

// Delivery zone types
export interface DeliveryZone {
  id: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_km: number;
  is_active: boolean;
  base_delivery_fee: number;
  per_km_fee: number;
  created_at: Date;
}

// Session types
export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

// Location types
export interface Location {
  lat: number;
  lng: number;
}

export interface LocationUpdate {
  driver_id: string;
  lat: number;
  lng: number;
  speed?: number;
  heading?: number;
  timestamp: Date;
}

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// WebSocket message types
export interface WSMessage {
  type: string;
  payload: unknown;
}

export interface LocationUpdateMessage {
  type: 'location_update';
  payload: {
    lat: number;
    lng: number;
    eta_seconds: number;
  };
}

export interface StatusUpdateMessage {
  type: 'status_update';
  payload: {
    status: OrderStatus;
    timestamp: string;
  };
}

export interface DriverAssignedMessage {
  type: 'driver_assigned';
  payload: {
    driver_id: string;
    driver_name: string;
    vehicle_type: string;
    rating: number;
  };
}

export interface NewOfferMessage {
  type: 'new_offer';
  payload: {
    offer_id: string;
    order: OrderWithDetails;
    expires_in: number;
    pickup_distance: number;
    delivery_distance: number;
  };
}

// Rating types
export interface Rating {
  id: string;
  order_id: string;
  rater_id: string | null;
  rated_user_id: string | null;
  rated_merchant_id: string | null;
  rating: number;
  comment: string | null;
  created_at: Date;
}

export interface CreateRatingInput {
  order_id: string;
  rating: number;
  comment?: string;
}

// Matching score for driver assignment
export interface MatchingScore {
  driver_id: string;
  total_score: number;
  factors: {
    distance: number;
    rating: number;
    acceptance_rate: number;
    current_orders: number;
  };
}

// ETA calculation
export interface ETABreakdown {
  total_seconds: number;
  pickup_eta: number;
  delivery_eta: number;
  legs: {
    destination: string;
    time: number;
  }[];
}
