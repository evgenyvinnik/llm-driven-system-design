export interface User {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  headline?: string;
  summary?: string;
  location?: string;
  industry?: string;
  profile_image_url?: string;
  banner_image_url?: string;
  connection_count: number;
  role: 'user' | 'admin';
  created_at: string;
  updated_at: string;
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
}

export interface Skill {
  id: number;
  name: string;
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
  start_date: string;
  end_date?: string;
  description?: string;
  is_current: boolean;
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
}

export interface ConnectionRequest {
  id: number;
  from_user_id: number;
  to_user_id: number;
  message?: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
  from_user?: User;
}

export interface Post {
  id: number;
  user_id: number;
  content: string;
  image_url?: string;
  like_count: number;
  comment_count: number;
  share_count: number;
  created_at: string;
  author?: User;
  has_liked?: boolean;
}

export interface PostComment {
  id: number;
  post_id: number;
  user_id: number;
  content: string;
  created_at: string;
  author?: User;
}

export interface Job {
  id: number;
  company_id: number;
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
  created_at: string;
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
  created_at: string;
  job?: Job;
}

export interface PYMKCandidate {
  user: User;
  score: number;
  mutual_connections: number;
  same_company: boolean;
  same_school: boolean;
  shared_skills: number;
  same_location: boolean;
}
