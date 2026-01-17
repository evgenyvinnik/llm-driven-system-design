export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  role: 'user' | 'business_owner' | 'admin';
  review_count: number;
  created_at?: string;
}

export interface Business {
  id: string;
  name: string;
  slug: string;
  description?: string;
  address: string;
  city: string;
  state: string;
  zip_code: string;
  latitude: number;
  longitude: number;
  phone?: string;
  website?: string;
  email?: string;
  price_level?: number;
  rating: number;
  review_count: number;
  photo_count: number;
  is_claimed: boolean;
  is_verified: boolean;
  owner_id?: string;
  categories?: Category[] | string[];
  category_names?: string[];
  photos?: BusinessPhoto[];
  hours?: BusinessHours[];
  photo_url?: string;
  distance_km?: number;
  distance?: number;
  is_owner?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  parent_id?: string;
  icon?: string;
  business_count?: number;
  subcategories?: Category[];
}

export interface BusinessPhoto {
  id: string;
  url: string;
  caption?: string;
  is_primary: boolean;
}

export interface BusinessHours {
  day_of_week: number;
  open_time: string;
  close_time: string;
  is_closed: boolean;
}

export interface Review {
  id: string;
  business_id: string;
  user_id: string;
  rating: number;
  text: string;
  helpful_count: number;
  funny_count: number;
  cool_count: number;
  user_name: string;
  user_avatar?: string;
  user_review_count?: number;
  business_name?: string;
  business_slug?: string;
  business_city?: string;
  business_photo?: string;
  photos?: string[];
  response_text?: string;
  response_created_at?: string;
  created_at: string;
  updated_at: string;
}

export interface SearchFilters {
  query?: string;
  category?: string;
  latitude?: number;
  longitude?: number;
  distance?: string;
  minRating?: number;
  maxPriceLevel?: number;
  sortBy?: 'relevance' | 'rating' | 'review_count' | 'distance';
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface AdminStats {
  total_users: number;
  total_businesses: number;
  total_reviews: number;
  claimed_businesses: number;
  unclaimed_businesses: number;
  reviews_last_24h: number;
  new_users_last_7d: number;
  average_rating: string;
  top_cities: Array<{ city: string; state: string; count: number }>;
}
