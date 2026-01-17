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

export interface UserPreferences {
  user_id: string;
  interested_in: string[];
  age_min: number;
  age_max: number;
  distance_km: number;
  show_me: boolean;
}

export interface Photo {
  id: string;
  user_id: string;
  url: string;
  position: number;
  is_primary: boolean;
  created_at: Date;
}

export interface Swipe {
  id: string;
  swiper_id: string;
  swiped_id: string;
  direction: 'like' | 'pass';
  created_at: Date;
}

export interface Match {
  id: string;
  user1_id: string;
  user2_id: string;
  matched_at: Date;
  last_message_at: Date | null;
}

export interface Message {
  id: string;
  match_id: string;
  sender_id: string;
  content: string;
  sent_at: Date;
  read_at: Date | null;
}

export interface UserProfile extends User {
  photos: Photo[];
  preferences: UserPreferences | null;
  age: number;
  distance?: number;
}

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
