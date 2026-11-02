export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url?: string;
  role: string;
  created_at: string;
}

/** What the signed-in user may do in a space (from the server). */
export interface SpaceAccessInfo {
  role: 'admin' | 'member' | 'viewer' | null;
  canEdit: boolean;
  canAdmin: boolean;
}

export interface Space {
  access?: SpaceAccessInfo;
  id: string;
  key: string;
  name: string;
  description: string;
  homepage_id: string | null;
  is_public: boolean;
  created_by: string;
  creator_username?: string;
  page_count?: string;
  created_at: string;
  updated_at: string;
}

export interface Page {
  id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  content_json: object;
  content_html: string;
  content_text: string;
  version: number;
  status: string;
  position: number;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  author?: {
    username: string;
    display_name: string;
  };
  labels?: string[];
  breadcrumbs?: Array<{ id: string; title: string; slug: string }>;
  access?: SpaceAccessInfo;
  space_key?: string;
  space_name?: string;
  author_username?: string;
}

export interface PageTreeNode extends Page {
  children: PageTreeNode[];
}

export interface PageVersion {
  id: string;
  page_id: string;
  version_number: number;
  title: string;
  content_json: object;
  content_html: string;
  content_text: string;
  change_message: string;
  created_by: string;
  created_at: string;
  author_username?: string;
}

export interface DiffChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface DiffResult {
  fromVersion: number;
  toVersion: number;
  changes: DiffChange[];
  titleChanged: boolean;
  fromTitle: string;
  toTitle: string;
}

export interface Comment {
  id: string;
  page_id: string;
  user_id: string;
  parent_id: string | null;
  content: string;
  is_resolved: boolean;
  created_at: string;
  updated_at: string;
  username: string;
  display_name: string;
  avatar_url?: string;
  replies?: Comment[];
}

export interface Template {
  id: string;
  space_id: string | null;
  name: string;
  description: string;
  content_json: object;
  is_global: boolean;
  created_by: string;
  creator_username?: string;
  created_at: string;
}

export interface Approval {
  id: string;
  page_id: string;
  requested_by: string;
  reviewed_by: string | null;
  status: string;
  comment: string | null;
  created_at: string;
  reviewed_at: string | null;
  requester_username?: string;
  reviewer_username?: string;
  page_title?: string;
  space_key?: string;
}

export interface SearchResult {
  page_id: string;
  space_id: string;
  space_key: string;
  slug: string;
  title: string;
  content_text: string;
  labels: string[];
  score: number;
  highlight?: {
    title?: string[];
    content_text?: string[];
  };
}
