/**
 * Database row interfaces and request body types for business-related operations.
 * @module routes/businesses/types
 */

/**
 * Represents a business entity as returned from the database.
 * Contains all business information including location, ratings, and ownership details.
 */
export interface BusinessRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  address: string;
  city: string;
  state: string;
  zip_code: string;
  country: string;
  latitude: number;
  longitude: number;
  phone: string | null;
  website: string | null;
  email: string | null;
  price_level: number | null;
  rating: number;
  review_count: number;
  photo_count: number;
  is_claimed: boolean;
  is_verified: boolean;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  categories?: string[] | null;
  category_names?: string[] | null;
  photo_url?: string | null;
  distance_km?: number;
  hours?: BusinessHour[];
  photos?: BusinessPhoto[];
  owner_name?: string | null;
  is_owner?: boolean;
}

/**
 * Represents business operating hours for a specific day of the week.
 */
export interface BusinessHour {
  /** Day of the week (0 = Sunday, 6 = Saturday) */
  day_of_week: number;
  /** Opening time in HH:MM format */
  open_time: string;
  /** Closing time in HH:MM format */
  close_time: string;
  /** Whether the business is closed on this day */
  is_closed: boolean;
}

/**
 * Represents a photo associated with a business.
 */
export interface BusinessPhoto {
  id: string;
  url: string;
  caption: string | null;
  is_primary: boolean;
}

/**
 * Database row for checking business ownership.
 */
export interface OwnerCheckRow {
  /** UUID of the business owner, null if unclaimed */
  owner_id: string | null;
}

/**
 * Database row for checking business claim status.
 */
export interface ClaimCheckRow {
  /** Whether the business has been claimed by an owner */
  is_claimed: boolean;
  /** UUID of the business owner, null if unclaimed */
  owner_id: string | null;
}

/**
 * Database row for count queries.
 */
export interface CountRow {
  /** The count value as a string (PostgreSQL returns bigint as string) */
  count: string;
}

/**
 * Represents a review with associated user information.
 * Includes the reviewer's profile data and any owner responses.
 */
export interface ReviewWithUser {
  id: string;
  business_id: string;
  user_id: string;
  rating: number;
  text: string;
  helpful_count: number;
  created_at: string;
  updated_at: string;
  user_name: string;
  user_avatar: string | null;
  user_review_count: number;
  response_text: string | null;
  response_created_at: string | null;
  photos: string[] | null;
}

/**
 * Represents a business category.
 */
export interface CategoryRow {
  /** URL-friendly category identifier */
  slug: string;
  /** Human-readable category name */
  name: string;
}

/**
 * Request body for creating a new business.
 */
export interface CreateBusinessBody {
  name: string;
  description?: string;
  address: string;
  city: string;
  state: string;
  zip_code: string;
  country?: string;
  latitude: number;
  longitude: number;
  phone?: string;
  website?: string;
  email?: string;
  price_level?: number;
  categories?: string[];
}

/**
 * Request body for updating an existing business.
 * All fields are optional; only provided fields will be updated.
 */
export interface UpdateBusinessBody {
  name?: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  phone?: string;
  website?: string;
  email?: string;
  price_level?: number;
  latitude?: number;
  longitude?: number;
  categories?: string[];
}

/**
 * Request body for adding or updating business hours.
 */
export interface AddHoursBody {
  /** Array of business hours for each day of the week */
  hours: Array<{
    /** Day of the week (0 = Sunday, 6 = Saturday) */
    day_of_week: number;
    /** Opening time in HH:MM format */
    open_time: string;
    /** Closing time in HH:MM format */
    close_time: string;
    /** Whether the business is closed on this day */
    is_closed?: boolean;
  }>;
}

/**
 * Request body for adding a photo to a business.
 */
export interface AddPhotoBody {
  /** URL of the photo */
  url: string;
  /** Optional caption for the photo */
  caption?: string;
  /** Whether this should be the primary photo for the business */
  is_primary?: boolean;
}

/**
 * Generates a URL-friendly slug from a business name.
 * Converts to lowercase, removes special characters, and replaces spaces with hyphens.
 *
 * @description Transforms a business name into a URL-safe slug identifier
 * @param name - The business name to convert
 * @returns A URL-friendly slug string
 * @example
 * generateSlug("Joe's Coffee Shop") // Returns "joes-coffee-shop"
 * generateSlug("The Best Restaurant!") // Returns "the-best-restaurant"
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}
