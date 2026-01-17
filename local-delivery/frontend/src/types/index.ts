// User types
export interface User {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: 'customer' | 'driver' | 'merchant' | 'admin';
  created_at: string;
  updated_at: string;
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
  location_updated_at: string | null;
  name?: string;
  email?: string;
  phone?: string | null;
}

export interface DriverStats {
  rating: number;
  total_deliveries: number;
  acceptance_rate: number;
  current_orders: number;
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
  distance?: number;
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
  estimated_delivery_time: string | null;
  actual_delivery_time: string | null;
  created_at: string;
  confirmed_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  name: string;
  quantity: number;
  unit_price: number;
  special_instructions: string | null;
}

export interface OrderWithDetails extends Order {
  items: OrderItem[];
  merchant?: Merchant;
  driver?: { id: string; name: string; vehicle_type: string; rating: number };
  customer?: { name: string; phone: string | null };
}

// Cart types
export interface CartItem {
  menuItem: MenuItem;
  quantity: number;
  specialInstructions?: string;
}

// Driver offer types
export interface DriverOffer {
  id: string;
  order_id: string;
  driver_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
}

// Location types
export interface Location {
  lat: number;
  lng: number;
}

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Auth types
export interface AuthResponse {
  user: User;
  token: string;
  expires_at: string;
}

// WebSocket message types
export interface WSMessage {
  type: string;
  payload?: unknown;
}

export interface LocationUpdatePayload {
  lat: number;
  lng: number;
  eta_seconds: number;
  timestamp: number;
}

export interface StatusUpdatePayload {
  status: OrderStatus;
  timestamp: string;
}

export interface NewOfferPayload {
  offer_id: string;
  order: OrderWithDetails;
  expires_in: number;
}

// Admin dashboard types
export interface DashboardStats {
  orders: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    cancelled: number;
    today: number;
  };
  drivers: {
    total: number;
    online: number;
    busy: number;
  };
  merchants: {
    total: number;
    open: number;
  };
  customers: {
    total: number;
    active_today: number;
  };
}
