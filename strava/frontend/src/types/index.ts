export interface User {
  id: string;
  username: string;
  email?: string;
  profilePhoto?: string;
  bio?: string;
  location?: string;
  role?: 'user' | 'admin';
  weightKg?: number;
  createdAt?: string;
  activityCount?: number;
  followerCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  isOwnProfile?: boolean;
}

export interface Activity {
  id: string;
  user_id: string;
  username?: string;
  profile_photo?: string;
  type: 'run' | 'ride' | 'hike' | 'swim' | 'walk';
  name: string;
  description?: string;
  start_time: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  elevation_gain: number;
  avg_speed?: number;
  max_speed?: number;
  avg_heart_rate?: number;
  max_heart_rate?: number;
  calories?: number;
  privacy: 'public' | 'followers' | 'private';
  polyline?: string;
  start_lat?: number;
  start_lng?: number;
  end_lat?: number;
  end_lng?: number;
  kudos_count: number;
  comment_count: number;
  hasKudos?: boolean;
  created_at: string;
  segmentEfforts?: SegmentEffort[];
}

export interface GpsPoint {
  point_index: number;
  timestamp?: string;
  latitude: number;
  longitude: number;
  altitude?: number;
  speed?: number;
  heart_rate?: number;
  cadence?: number;
  power?: number;
}

export interface Segment {
  id: string;
  creator_id: string;
  creator_name?: string;
  name: string;
  activity_type: string;
  distance: number;
  elevation_gain?: number;
  polyline: string;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  effort_count: number;
  athlete_count: number;
  created_at: string;
  leaderboard?: LeaderboardEntry[];
  userRank?: { rank: number; elapsedTime: number } | null;
}

export interface SegmentEffort {
  id: string;
  segment_id: string;
  activity_id: string;
  user_id: string;
  segment_name?: string;
  segment_distance?: number;
  elapsed_time: number;
  moving_time: number;
  start_index: number;
  end_index: number;
  avg_speed?: number;
  max_speed?: number;
  pr_rank?: number;
  created_at: string;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  elapsedTime: number;
  user: {
    id: string;
    username: string;
    profile_photo?: string;
  };
}

export interface Comment {
  id: string;
  content: string;
  created_at: string;
  user_id: string;
  username: string;
  profile_photo?: string;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  criteria_type: string;
  criteria_value: number;
  earned?: boolean;
  earned_at?: string;
}

export interface UserStats {
  overall: {
    total_activities: number;
    total_distance: number;
    total_time: number;
    total_elevation: number;
  };
  byType: {
    type: string;
    activity_count: number;
    total_distance: number;
    total_time: number;
    total_elevation: number;
  }[];
  weekly: {
    week: string;
    activity_count: number;
    total_distance: number;
    total_time: number;
  }[];
  segments: {
    total_efforts: number;
    unique_segments: number;
    podium_finishes: number;
  };
  kudosReceived: number;
  achievements: Achievement[];
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}
