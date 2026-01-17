/**
 * Core user entity with profile and account information.
 */
export interface User {
  id: string;
  email: string;
  name: string;
  birthdate: string;
  gender: string;
  bio: string | null;
  job_title: string | null;
  company: string | null;
  school: string | null;
  latitude: number | null;
  longitude: number | null;
  last_active: string;
  created_at: string;
  is_admin: boolean;
  age: number;
  photos: Photo[];
  preferences: UserPreferences | null;
}

/**
 * User discovery preferences for filtering potential matches.
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
 */
export interface Photo {
  id: string;
  user_id: string;
  url: string;
  position: number;
  is_primary: boolean;
  created_at: string;
}

/**
 * Profile card shown in the discovery swipe deck.
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
 * Match with another user including conversation preview.
 */
export interface Match {
  id: string;
  matched_at: string;
  last_message_at: string | null;
  last_message_preview?: string;
  unread_count: number;
  user: {
    id: string;
    name: string;
    primary_photo: string | null;
  };
}

/**
 * Chat message in a match conversation.
 */
export interface Message {
  id: string;
  sender_id: string;
  content: string;
  sent_at: string;
  read_at: string | null;
  is_mine: boolean;
}

/**
 * Result of a swipe action, including match data if mutual.
 */
export interface SwipeResult {
  success: boolean;
  match: {
    id: string;
    user: {
      id: string;
      name: string;
      primary_photo: string | null;
    };
  } | null;
}

/**
 * Admin dashboard statistics for platform metrics.
 */
export interface AdminStats {
  users: {
    total: number;
    newToday: number;
    activeToday: number;
    maleCount: number;
    femaleCount: number;
    onlineNow: number;
    activeLastHour: number;
  };
  matches: {
    totalMatches: number;
    matchesToday: number;
    totalSwipes: number;
    swipesToday: number;
    likeRate: number;
  };
  messages: {
    totalMessages: number;
    messagesToday: number;
    avgMessagesPerMatch: number;
  };
}
