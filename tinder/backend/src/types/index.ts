/**
 * Core user entity representing a registered user in the system.
 * Contains profile information, location data, and authentication details.
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  birthdate: Date;
  gender: string;
  bio: string | null;
  job_title: string | null;
  company: string | null;
  school: string | null;
  latitude: number | null;
  longitude: number | null;
  last_active: Date;
  created_at: Date;
  is_admin: boolean;
}

/**
 * User discovery preferences controlling who appears in their swipe deck.
 * Used by the discovery algorithm to filter potential matches.
 */
export interface UserPreferences {
  user_id: string;
  interested_in: string[];
  age_min: number;
  age_max: number;
  distance_km: number;
  show_me: boolean;
}

/**
 * User profile photo with ordering metadata.
 * First photo (position 0) is typically displayed as the primary profile image.
 */
export interface Photo {
  id: string;
  user_id: string;
  url: string;
  position: number;
  is_primary: boolean;
  created_at: Date;
}

/**
 * Records a user's swipe action on another user's profile.
 * Used for match detection when both users swipe 'like' on each other.
 */
export interface Swipe {
  id: string;
  swiper_id: string;
  swiped_id: string;
  direction: 'like' | 'pass';
  created_at: Date;
}

/**
 * Represents a mutual match between two users who both liked each other.
 * Created automatically when mutual likes are detected during swipe processing.
 */
export interface Match {
  id: string;
  user1_id: string;
  user2_id: string;
  matched_at: Date;
  last_message_at: Date | null;
}

/**
 * A chat message sent between matched users.
 * Messages can only be sent within an existing match context.
 */
export interface Message {
  id: string;
  match_id: string;
  sender_id: string;
  content: string;
  sent_at: Date;
  read_at: Date | null;
}

/**
 * Extended user profile combining user data with photos, preferences, and computed age.
 * Used when returning complete profile information to clients.
 */
export interface UserProfile extends User {
  photos: Photo[];
  preferences: UserPreferences | null;
  age: number;
  distance?: number;
}

/**
 * Card displayed in the discovery swipe deck.
 * Contains essential profile info with pre-formatted distance for display.
 * Score field is used internally for ranking candidates.
 */
export interface DiscoveryCard {
  id: string;
  name: string;
  age: number;
  bio: string | null;
  job_title: string | null;
  company: string | null;
  school: string | null;
  distance: string;
  photos: Photo[];
  score?: number;
}

/**
 * Match data enriched with the other user's basic info for list display.
 * Includes last message preview for conversation threads.
 */
export interface MatchWithUser {
  id: string;
  matched_at: Date;
  last_message_at: Date | null;
  last_message_preview?: string;
  user: {
    id: string;
    name: string;
    primary_photo: string | null;
  };
}

/**
 * Message formatted for conversation display with ownership flag.
 * The is_mine field indicates whether the current user sent this message.
 */
export interface ConversationMessage {
  id: string;
  sender_id: string;
  content: string;
  sent_at: Date;
  read_at: Date | null;
  is_mine: boolean;
}

declare module 'express-session' {
  interface SessionData {
    userId: string;
  }
}
