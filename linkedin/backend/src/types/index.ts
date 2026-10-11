export interface User {
  id: number;
  /** Only present on the member's own record (login, /auth/me); never on public projections */
  email?: string;
  first_name: string;
  last_name: string;
  headline?: string;
  summary?: string;
  location?: string;
  industry?: string;
  profile_image_url?: string;
  banner_image_url?: string;
  connection_count: number;
  role: 'user' | 'recruiter' | 'admin';
  created_at: Date;
  updated_at: Date;
}

/** Card-sized public view of a member: what feed authors, paths and suggestions show. */
export interface UserSummary {
  id: number;
  first_name: string;
  last_name: string;
  headline?: string;
  location?: string;
  profile_image_url?: string;
  connection_count: number;
}

export interface Company {
  id: number;
  name: string;
  slug: string;
  description?: string;
  industry?: string;
  size?: string;
  location?: string;
  website?: string;
  logo_url?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Skill {
  id: number;
  name: string;
  created_at: Date;
}

export interface UserSkill {
  user_id: number;
  skill_id: number;
  endorsement_count: number;
  skill_name?: string;
}

export interface Experience {
  id: number;
  user_id: number;
  company_id?: number;
  company_name: string;
  title: string;
  location?: string;
  start_date: Date;
  end_date?: Date;
  description?: string;
  is_current: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Education {
  id: number;
  user_id: number;
  school_name: string;
  degree?: string;
  field_of_study?: string;
  start_year?: number;
  end_year?: number;
  description?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Connection {
  user_id: number;
  connected_to: number;
  connected_at: Date;
}

export interface ConnectionRequest {
  id: number;
  from_user_id: number;
  to_user_id: number;
  message?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn';
  created_at: Date;
  updated_at: Date;
}

/**
 * How the viewer relates to another member: what the profile header renders.
 * `status` drives the action button; `degree` and `path` drive the badge and the
 * "how you're connected" line.
 */
export interface Relationship {
  degree: 0 | 1 | 2 | 3 | null;
  status: 'self' | 'connected' | 'pending_sent' | 'pending_received' | 'none';
  /** Id of the pending request in either direction, so the client can accept it */
  request_id: number | null;
  mutual_count: number;
  /** Viewer to target inclusive (2 to 4 members); empty when out of network */
  path: UserSummary[];
}

export interface Post {
  id: number;
  user_id: number;
  content: string;
  image_url?: string;
  like_count: number;
  comment_count: number;
  share_count: number;
  created_at: Date;
  updated_at: Date;
  author?: User;
  has_liked?: boolean;
}

export interface PostComment {
  id: number;
  post_id: number;
  user_id: number;
  content: string;
  created_at: Date;
  updated_at: Date;
  author?: User;
}

export interface Job {
  id: number;
  company_id: number;
  posted_by_user_id?: number;
  title: string;
  description: string;
  location?: string;
  is_remote: boolean;
  employment_type?: string;
  experience_level?: string;
  years_required?: number;
  salary_min?: number;
  salary_max?: number;
  status: 'active' | 'closed' | 'draft';
  created_at: Date;
  updated_at: Date;
  company?: Company;
  required_skills?: Skill[];
  match_score?: number;
}

export interface JobApplication {
  id: number;
  job_id: number;
  user_id: number;
  resume_url?: string;
  cover_letter?: string;
  status: 'pending' | 'reviewed' | 'accepted' | 'rejected';
  match_score?: number;
  created_at: Date;
  updated_at: Date;
  applicant?: User;
  job?: Job;
}

export interface ConnectionDegree {
  user_id: number;
  degree: number;
  mutual_count?: number;
}

export interface PYMKCandidate {
  user: UserSummary;
  score: number;
  mutual_connections: number;
  same_company: boolean;
  same_school: boolean;
  shared_skills: number;
  same_location: boolean;
  /** Why this person is suggested, strongest reason first */
  reasons: string[];
}

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    role?: string;
  }
}
