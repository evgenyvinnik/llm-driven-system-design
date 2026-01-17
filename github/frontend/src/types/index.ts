export interface User {
  id: number;
  username: string;
  email: string;
  display_name: string;
  bio?: string;
  avatar_url?: string;
  location?: string;
  company?: string;
  website?: string;
  role: 'user' | 'admin';
  created_at: string;
}

export interface Repository {
  id: number;
  owner_id: number;
  org_id?: number;
  name: string;
  description?: string;
  is_private: boolean;
  default_branch: string;
  storage_path: string;
  language?: string;
  stars_count: number;
  forks_count: number;
  watchers_count: number;
  owner_name: string;
  owner_avatar?: string;
  branches?: Branch[];
  tags?: string[];
  created_at: string;
  updated_at: string;
}

export interface Branch {
  name: string;
  current: boolean;
}

export interface TreeItem {
  mode: string;
  type: 'file' | 'dir';
  sha: string;
  size?: number;
  name: string;
  path: string;
}

export interface Commit {
  sha: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
  date: string;
  diff?: string;
}

export interface PullRequest {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed' | 'merged';
  head_branch: string;
  head_sha: string;
  base_branch: string;
  base_sha: string;
  author_id: number;
  author_name: string;
  author_avatar?: string;
  merged_by?: number;
  merged_by_name?: string;
  merged_at?: string;
  additions: number;
  deletions: number;
  changed_files: number;
  is_draft: boolean;
  commits?: Commit[];
  reviews?: Review[];
  labels?: Label[];
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

export interface Review {
  id: number;
  pr_id: number;
  reviewer_id: number;
  reviewer_name: string;
  reviewer_avatar?: string;
  state: 'approved' | 'changes_requested' | 'commented';
  body?: string;
  commit_sha: string;
  created_at: string;
}

export interface Issue {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed';
  author_id: number;
  author_name: string;
  author_avatar?: string;
  assignee_id?: number;
  assignee_name?: string;
  assignee_avatar?: string;
  labels?: Label[];
  comments?: Comment[];
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

export interface Label {
  id: number;
  repo_id: number;
  name: string;
  color: string;
  description?: string;
}

export interface Comment {
  id: number;
  issue_id?: number;
  pr_id?: number;
  user_id: number;
  user_name: string;
  user_avatar?: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Discussion {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string;
  category: string;
  author_id: number;
  author_name: string;
  author_avatar?: string;
  is_answered: boolean;
  answer_comment_id?: number;
  comments_count?: number;
  comments?: DiscussionComment[];
  created_at: string;
  updated_at: string;
}

export interface DiscussionComment {
  id: number;
  discussion_id: number;
  user_id: number;
  user_name: string;
  user_avatar?: string;
  parent_id?: number;
  body: string;
  upvotes: number;
  replies?: DiscussionComment[];
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: number;
  name: string;
  display_name?: string;
  description?: string;
  avatar_url?: string;
  website?: string;
  location?: string;
  members_count?: number;
  repos_count?: number;
  created_at: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  files: {
    path: string;
    additions: number;
    deletions: number;
    changes: number;
  }[];
}

export interface SearchResult {
  repo_id: string;
  repo_name: string;
  owner: string;
  path: string;
  language: string;
  highlights: string[];
  score: number;
}
