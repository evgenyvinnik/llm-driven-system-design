// User types
export interface User {
  id: number;
  email: string;
  name: string;
  phone?: string;
  role: 'customer' | 'restaurant_owner' | 'driver' | 'admin';
  created_at: string;
  driverProfile?: Driver;
}

// Restaurant types
export interface Restaurant {
  id: number;
  owner_id?: number;
  name: string;
  description?: string;
  address: string;
  lat: number;
  lon: number;
  cuisine_type?: string;
  rating: number;
  rating_count: number;
  prep_time_minutes: number;
  is_open: boolean;
  image_url?: string;
  delivery_fee: number;
  min_order: number;
  distance?: number;
}

export interface MenuItem {
  id: number;
  restaurant_id: number;
  name: string;
  description?: string;
  price: number;
  category?: string;
  image_url?: string;
  is_available: boolean;
}

export type MenuByCategory = Record<string, MenuItem[]>;

// Driver types
export interface Driver {
  id: number;
  user_id: number;
  name: string;
  phone?: string;
  vehicle_type: 'car' | 'bike' | 'scooter' | 'walk';
  license_plate?: string;
  is_active: boolean;
  is_available: boolean;
  current_lat?: number;
  current_lon?: number;
  rating: number;
  rating_count: number;
  total_deliveries: number;
}

// Order types
export type OrderStatus =
  | 'PLACED'
  | 'CONFIRMED'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'PICKED_UP'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface DeliveryAddress {
  address: string;
  lat: number;
  lon: number;
  apt?: string;
  instructions?: string;
}

export interface OrderItem {
  id: number;
  order_id: number;
  menu_item_id: number;
  name: string;
  price: number;
  quantity: number;
  special_instructions?: string;
}

export interface Order {
  id: number;
  customer_id: number;
  restaurant_id: number;
  driver_id?: number;
  status: OrderStatus;
  subtotal: number;
  delivery_fee: number;
  tax: number;
  tip: number;
  total: number;
  delivery_address: DeliveryAddress;
  delivery_instructions?: string;
  estimated_delivery_at?: string;
  placed_at: string;
  confirmed_at?: string;
  preparing_at?: string;
  ready_at?: string;
  picked_up_at?: string;
  delivered_at?: string;
  cancelled_at?: string;
  cancel_reason?: string;
  items: OrderItem[];
  restaurant?: Restaurant;
  restaurant_name?: string;
  restaurant_address?: string;
  restaurant_image?: string;
  driver?: Driver;
  eta_breakdown?: ETABreakdown;
}

export interface ETABreakdown {
  toRestaurantMinutes: number;
  prepTimeMinutes: number;
  deliveryMinutes: number;
  bufferMinutes: number;
  totalMinutes: number;
}

// Cart types
export interface CartItem {
  menuItem: MenuItem;
  quantity: number;
  specialInstructions?: string;
}

// WebSocket message types
export interface WSMessage {
  type: string;
  [key: string]: unknown;
}
