// User types
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  role: 'user' | 'admin';
  created_at: string;
  updated_at: string;
}

// Project types
export interface Project {
  id: string;
  key: string;
  name: string;
  description?: string;
  lead_id: string;
  workflow_id: number;
  permission_scheme_id: number;
  issue_counter: number;
  created_at: string;
  updated_at: string;
}

// Issue types
export type IssueType = 'bug' | 'story' | 'task' | 'epic' | 'subtask';
export type Priority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

export interface Issue {
  id: number;
  project_id: string;
  key: string;
  summary: string;
  description?: string;
  issue_type: IssueType;
  status_id: number;
  priority: Priority;
  assignee_id?: string;
  reporter_id: string;
  parent_id?: number;
  epic_id?: number;
  sprint_id?: number;
  story_points?: number;
  labels: string[];
  components: number[];
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface IssueWithDetails extends Issue {
  status: Status;
  assignee?: User;
  reporter: User;
  project: Pick<Project, 'id' | 'key' | 'name'>;
  epic?: Pick<Issue, 'id' | 'key' | 'summary'>;
  sprint?: Sprint;
}

// Status types
export type StatusCategory = 'todo' | 'in_progress' | 'done';

export interface Status {
  id: number;
  name: string;
  category: StatusCategory;
  color: string;
  workflow_id: number;
  position: number;
}

// Workflow types
export interface Workflow {
  id: number;
  name: string;
  description?: string;
  is_default: boolean;
  statuses: Status[];
  transitions: Transition[];
}

// Transition types
export interface Transition {
  id: number;
  workflow_id: number;
  name: string;
  from_status_id: number | null;
  to_status_id: number;
  to_status?: Status;
}

// Sprint types
export type SprintStatus = 'future' | 'active' | 'closed';

export interface Sprint {
  id: number;
  project_id: string;
  name: string;
  goal?: string;
  start_date?: string;
  end_date?: string;
  status: SprintStatus;
  created_at: string;
  updated_at: string;
}

// Comment types
export interface Comment {
  id: number;
  issue_id: number;
  author_id: string;
  body: string;
  author: User;
  created_at: string;
  updated_at: string;
}

// History types
export interface IssueHistory {
  id: number;
  issue_id: number;
  user_id: string;
  field: string;
  old_value?: string;
  new_value?: string;
  user: User;
  created_at: string;
}

// Board types
export type BoardType = 'kanban' | 'scrum';

export interface Board {
  id: number;
  project_id: string;
  name: string;
  type: BoardType;
  filter_jql?: string;
  column_config: BoardColumn[];
  created_at: string;
}

export interface BoardColumn {
  name: string;
  status_ids: number[];
}

// Label types
export interface Label {
  id: number;
  project_id: string;
  name: string;
  color: string;
}

// Component types
export interface Component {
  id: number;
  project_id: string;
  name: string;
  description?: string;
  lead_id?: string;
}

// Project Role types
export interface ProjectRole {
  id: number;
  name: string;
  description?: string;
}

// Search types
export interface SearchResult {
  issues: IssueWithDetails[];
  total: number;
  took: number;
}

export interface Aggregations {
  statuses: { key: string; count: number }[];
  priorities: { key: string; count: number }[];
  issue_types: { key: string; count: number }[];
  assignees: { key: string; count: number }[];
  sprints: { key: string; count: number }[];
  labels: { key: string; count: number }[];
}
