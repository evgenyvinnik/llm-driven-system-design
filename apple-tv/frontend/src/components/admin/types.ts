/**
 * Platform statistics for admin dashboard.
 */
export interface AdminStats {
  /** Total registered users on the platform */
  totalUsers: number;
  /** Total content items (movies + series) */
  totalContent: number;
  /** Total video views across the platform */
  totalViews: number;
  /** Breakdown of active subscriptions by tier */
  activeSubscriptions: Record<string, number>;
}

/**
 * Content item type for admin content table.
 */
export interface AdminContent {
  /** Unique content identifier */
  id: string;
  /** Content title */
  title: string;
  /** Type of content (movie, series, episode) */
  content_type: string;
  /** Processing/availability status */
  status: string;
  /** Whether content is featured on home page */
  featured: boolean;
  /** Number of times content has been viewed */
  view_count: number;
  /** ISO timestamp of content creation */
  created_at: string;
}

/**
 * User data type for admin user listing.
 */
export interface AdminUser {
  /** Unique user identifier */
  id: string;
  /** User email address */
  email: string;
  /** User display name */
  name: string;
  /** User role (user or admin) */
  role: string;
  /** User's subscription tier */
  subscription_tier: string;
  /** ISO timestamp of account creation */
  created_at: string;
}
