export interface User {
  id: number;
  email: string;
  username: string;
  fullName?: string;
  role: 'user' | 'admin';
  avatarUrl?: string;
  shops?: Shop[];
  shopIds?: number[];
}

export interface Shop {
  id: number;
  owner_id: number;
  name: string;
  slug: string;
  description?: string;
  banner_image?: string;
  logo_image?: string;
  rating: number;
  review_count: number;
  sales_count: number;
  shipping_policy?: Record<string, unknown>;
  return_policy?: string;
  location?: string;
  is_active: boolean;
  created_at: string;
  owner_username?: string;
  product_count?: number;
}

export interface Product {
  id: number;
  shop_id: number;
  title: string;
  description?: string;
  price: number;
  compare_at_price?: number;
  quantity: number;
  category_id?: number;
  tags: string[];
  images: string[];
  is_vintage: boolean;
  is_handmade: boolean;
  shipping_price: number;
  processing_time?: string;
  view_count: number;
  favorite_count: number;
  is_active: boolean;
  created_at: string;
  shop_name?: string;
  shop_slug?: string;
  shop_rating?: number;
  category_name?: string;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  parent_id?: number;
  image_url?: string;
}

export interface CartItem {
  id: number;
  productId: number;
  title: string;
  price: number;
  quantity: number;
  available: number;
  images: string[];
  shippingPrice: number;
  itemTotal: number;
}

export interface CartShop {
  shopId: number;
  shopName: string;
  shopSlug: string;
  items: CartItem[];
  subtotal: number;
  shippingTotal: number;
}

export interface Cart {
  shops: CartShop[];
  summary: {
    itemTotal: number;
    shippingTotal: number;
    grandTotal: number;
    itemCount: number;
  };
}

export interface Order {
  id: number;
  buyer_id: number;
  shop_id: number;
  order_number: string;
  subtotal: number;
  shipping: number;
  total: number;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  shipping_address: Record<string, unknown>;
  tracking_number?: string;
  notes?: string;
  created_at: string;
  shop_name?: string;
  shop_slug?: string;
  items?: OrderItem[];
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number;
  title: string;
  price: number;
  quantity: number;
  image_url?: string;
}

export interface Review {
  id: number;
  order_id: number;
  product_id: number;
  shop_id: number;
  user_id: number;
  rating: number;
  comment?: string;
  images: string[];
  created_at: string;
  username?: string;
  avatar_url?: string;
}

export interface Favorite {
  id: number;
  user_id: number;
  favoritable_type: 'product' | 'shop';
  favoritable_id: number;
  created_at: string;
  name?: string;
  image?: string;
  price?: string;
  slug?: string;
}
