export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'merchant';
}

export interface Store {
  id: number;
  name: string;
  subdomain: string;
  custom_domain?: string;
  description?: string;
  logo_url?: string;
  currency: string;
  theme: StoreTheme;
  settings: Record<string, unknown>;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at?: string;
}

export interface StoreTheme {
  primaryColor: string;
  secondaryColor: string;
  fontFamily?: string;
}

export interface Product {
  id: number;
  store_id: number;
  handle: string;
  title: string;
  description?: string;
  images: ProductImage[];
  status: 'draft' | 'active' | 'archived';
  tags: string[];
  variants: Variant[];
  created_at: string;
  updated_at?: string;
}

export interface ProductImage {
  url: string;
  alt?: string;
}

export interface Variant {
  id: number;
  product_id: number;
  store_id: number;
  sku?: string;
  title: string;
  price: number;
  compare_at_price?: number;
  inventory_quantity: number;
  options: Record<string, string>;
  created_at: string;
  updated_at?: string;
}

export interface Collection {
  id: number;
  store_id: number;
  handle: string;
  title: string;
  description?: string;
  image_url?: string;
  products?: Product[];
  product_count?: number;
  created_at: string;
}

export interface Customer {
  id: number;
  store_id: number;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  accepts_marketing: boolean;
  order_count?: number;
  total_spent?: number;
  created_at: string;
}

export interface Order {
  id: number;
  store_id: number;
  order_number: string;
  customer_id?: number;
  customer_email: string;
  subtotal: number;
  shipping_cost: number;
  tax: number;
  total: number;
  payment_status: 'pending' | 'paid' | 'refunded' | 'failed';
  fulfillment_status: 'unfulfilled' | 'partial' | 'fulfilled';
  shipping_address: Address;
  billing_address: Address;
  notes?: string;
  items?: OrderItem[];
  created_at: string;
  updated_at?: string;
}

export interface OrderItem {
  id: number;
  order_id: number;
  variant_id: number;
  title: string;
  variant_title: string;
  sku?: string;
  quantity: number;
  price: number;
  total: number;
}

export interface Address {
  first_name?: string;
  last_name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  phone?: string;
}

export interface Cart {
  id: number;
  store_id: number;
  session_id: string;
  items: CartItem[];
  subtotal: number;
  line_items?: CartLineItem[];
}

export interface CartItem {
  variant_id: number;
  quantity: number;
}

export interface CartLineItem {
  variant_id: number;
  product_id: number;
  product_title: string;
  variant_title: string;
  price: number;
  image?: string;
  quantity: number;
}

export interface Analytics {
  orders: {
    total: number;
    revenue: number;
    paid: number;
    unfulfilled: number;
  };
  products: {
    total: number;
  };
  customers: {
    total: number;
  };
  recentOrders: Order[];
}
