// User types
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
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
  created_at: Date;
  updated_at: Date;
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
  components: string[];
  custom_fields: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
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
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowWithStatuses extends Workflow {
  statuses: Status[];
  transitions: Transition[];
}

// Transition types
export interface Transition {
  id: number;
  workflow_id: number;
  name: string;
  from_status_id: number | null; // null means 'from any'
  to_status_id: number;
  conditions: TransitionCondition[];
  validators: TransitionValidator[];
  post_functions: TransitionPostFunction[];
}

export interface TransitionCondition {
  type: 'user_in_role' | 'issue_assignee' | 'user_in_group' | 'always';
  config: Record<string, unknown>;
}

export interface TransitionValidator {
  type: 'field_required' | 'field_value' | 'custom';
  config: Record<string, unknown>;
}

export interface TransitionPostFunction {
  type: 'update_field' | 'send_notification' | 'assign_to_current_user' | 'clear_field';
  config: Record<string, unknown>;
}

// Sprint types
export type SprintStatus = 'future' | 'active' | 'closed';

export interface Sprint {
  id: number;
  project_id: string;
  name: string;
  goal?: string;
  start_date?: Date;
  end_date?: Date;
  status: SprintStatus;
  created_at: Date;
  updated_at: Date;
}

// Comment types
export interface Comment {
  id: number;
  issue_id: number;
  author_id: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

export interface CommentWithAuthor extends Comment {
  author: User;
}

// History types
export interface IssueHistory {
  id: number;
  issue_id: number;
  user_id: string;
  field: string;
  old_value?: string;
  new_value?: string;
  created_at: Date;
}

export interface IssueHistoryWithUser extends IssueHistory {
  user: User;
}

// Custom field types
export type CustomFieldType = 'text' | 'number' | 'select' | 'multiselect' | 'date' | 'user' | 'checkbox';

export interface CustomFieldDefinition {
  id: number;
  project_id: string;
  name: string;
  type: CustomFieldType;
  config: Record<string, unknown>;
  required: boolean;
  created_at: Date;
}

// Permission types
export interface PermissionScheme {
  id: number;
  name: string;
  description?: string;
  is_default: boolean;
}

export interface PermissionGrant {
  scheme_id: number;
  permission: string;
  grantee_type: 'role' | 'user' | 'group' | 'anyone';
  grantee_id: string;
}

// Project Role types
export interface ProjectRole {
  id: number;
  name: string;
  description?: string;
}

export interface ProjectMember {
  project_id: string;
  user_id: string;
  role_id: number;
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
  created_at: Date;
}

export interface BoardColumn {
  name: string;
  status_ids: number[];
}

// Component types
export interface Component {
  id: number;
  project_id: string;
  name: string;
  description?: string;
  lead_id?: string;
}

// Label types
export interface Label {
  id: number;
  project_id: string;
  name: string;
  color: string;
}

// Session types
declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}
