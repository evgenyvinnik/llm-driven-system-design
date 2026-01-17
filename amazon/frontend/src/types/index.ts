export interface User {
  id: number;
  email: string;
  name: string;
  role: 'user' | 'admin' | 'seller';
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  parent_id: number | null;
  description: string | null;
  image_url: string | null;
  product_count?: number;
  children?: Category[];
}

export interface Product {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  price: string;
  compare_at_price: string | null;
  images: string[];
  rating: string | null;
  review_count: number;
  attributes: Record<string, unknown>;
  category_name: string | null;
  category_slug: string | null;
  seller_name: string | null;
  stock_quantity: number;
  created_at: string;
}

export interface CartItem {
  id: number;
  product_id: number;
  title: string;
  slug: string;
  price: string;
  images: string[];
  quantity: number;
  stock_quantity: number;
  reserved_until: string;
}

export interface Cart {
  items: CartItem[];
  subtotal: string;
  itemCount: number;
}

export interface OrderItem {
  id: number;
  product_id: number;
  product_title: string;
  quantity: number;
  price: string;
  images?: string[];
  slug?: string;
}

export interface Order {
  id: number;
  user_id: number;
  status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  subtotal: string;
  tax: string;
  shipping_cost: string;
  total: string;
  shipping_address: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  payment_status: 'pending' | 'completed' | 'failed' | 'refunded';
  created_at: string;
  items?: OrderItem[];
}

export interface Review {
  id: number;
  product_id: number;
  user_id: number;
  user_name: string;
  rating: number;
  title: string | null;
  content: string | null;
  helpful_count: number;
  verified_purchase: boolean;
  created_at: string;
}

export interface ReviewSummary {
  total_reviews: number;
  average_rating: string;
  five_star: number;
  four_star: number;
  three_star: number;
  two_star: number;
  one_star: number;
}

export interface SearchFilters {
  q?: string;
  category?: string;
  minPrice?: string;
  maxPrice?: string;
  inStock?: string;
  minRating?: string;
  sortBy?: string;
  page?: number;
}

export interface Aggregations {
  categories?: { buckets: { key: string; doc_count: number }[] };
  price_ranges?: { buckets: { key: string; doc_count: number }[] };
  rating_buckets?: { buckets: { key: string; doc_count: number }[] };
}
