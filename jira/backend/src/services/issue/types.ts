import { IssueType, Priority } from '../../types/index.js';

/**
 * Data required to create a new issue.
 *
 * @description Contains all fields needed to create a new issue within a project.
 * Required fields include projectId, summary, issueType, and reporterId.
 * Optional fields allow for additional context like description, priority, and assignee.
 *
 * @property projectId - UUID of the project to create the issue in
 * @property summary - Brief title/summary of the issue (required)
 * @property description - Detailed description of the issue
 * @property issueType - Type of issue (bug, story, task, epic, subtask)
 * @property priority - Priority level (lowest, low, medium, high, highest)
 * @property assigneeId - UUID of the user assigned to work on this issue
 * @property reporterId - UUID of the user reporting/creating this issue (required)
 * @property parentId - ID of parent issue (for subtasks)
 * @property epicId - ID of the epic this issue belongs to
 * @property sprintId - ID of the sprint this issue is assigned to
 * @property storyPoints - Estimated story points for the issue
 * @property labels - Array of label strings
 * @property components - Array of component names
 * @property customFields - Key-value pairs for custom field data
 *
 * @example
 * ```typescript
 * const issueData: CreateIssueData = {
 *   projectId: 'abc-123-def',
 *   summary: 'Fix login button not responding',
 *   description: 'Users report the login button does nothing when clicked',
 *   issueType: 'bug',
 *   priority: 'high',
 *   reporterId: 'user-456-xyz',
 *   labels: ['ui', 'critical']
 * };
 * ```
 */
export interface CreateIssueData {
  projectId: string;
  summary: string;
  description?: string;
  issueType: IssueType;
  priority?: Priority;
  assigneeId?: string;
  reporterId: string;
  parentId?: number;
  epicId?: number;
  sprintId?: number;
  storyPoints?: number;
  labels?: string[];
  components?: string[];
  customFields?: Record<string, unknown>;
}

/**
 * Data for updating an existing issue.
 *
 * @description All fields are optional to allow partial updates.
 * Only provided fields will be updated; undefined fields remain unchanged.
 * Use `null` values to explicitly clear optional fields like assigneeId, epicId, etc.
 *
 * @property summary - Updated issue title
 * @property description - Updated description
 * @property issueType - Change the issue type
 * @property priority - Updated priority level
 * @property assigneeId - New assignee UUID, or null to unassign
 * @property epicId - Epic ID to link, or null to unlink
 * @property sprintId - Sprint ID to assign, or null to remove from sprint
 * @property storyPoints - Updated story points, or null to clear
 * @property labels - Complete replacement of labels array
 * @property components - Complete replacement of components array
 * @property customFields - Shallow-merged into the existing custom fields
 *
 * @example
 * ```typescript
 * const updateData: UpdateIssueData = {
 *   priority: 'highest',
 *   assigneeId: 'dev-user-123',
 *   storyPoints: 5
 * };
 * ```
 */
export interface UpdateIssueData {
  summary?: string;
  description?: string | null;
  issueType?: IssueType;
  priority?: Priority;
  assigneeId?: string | null;
  epicId?: number | null;
  sprintId?: number | null;
  storyPoints?: number | null;
  labels?: string[];
  components?: string[];
  customFields?: Record<string, unknown>;
}

/**
 * Thrown when a write references something that does not belong to the issue's project
 * (a sprint, epic or parent from another project, or a user that does not exist).
 * Routes answer it with 422 and the offending field.
 */
export class IssueInputError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'IssueInputError';
  }
}

/**
 * History record for tracking field changes.
 *
 * @description Represents a single field change in the issue history audit trail.
 * Used to track what changed, the previous value, and the new value.
 *
 * @property field - Name of the field that changed (e.g., 'status', 'assignee', 'priority')
 * @property oldValue - Previous value as string, or null if field was previously empty
 * @property newValue - New value as string, or null if field was cleared
 *
 * @example
 * ```typescript
 * const historyRecord: HistoryRecord = {
 *   field: 'priority',
 *   oldValue: 'medium',
 *   newValue: 'high'
 * };
 * ```
 */
export interface HistoryRecord {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * Data used for indexing issues in Elasticsearch.
 *
 * @description Contains denormalized fields retrieved from related tables
 * for efficient search indexing. These fields are stored alongside the issue
 * data in Elasticsearch to enable filtering and searching without joins.
 *
 * @property status_name - Human-readable status name (e.g., 'In Progress')
 * @property status_category - Status category ('todo', 'in_progress', 'done')
 * @property project_key - Project key prefix (e.g., 'PROJ')
 * @property assignee_name - Full name of the assigned user
 * @property reporter_name - Full name of the reporter
 * @property sprint_name - Name of the assigned sprint
 * @property epic_key - Key of the linked epic (e.g., 'PROJ-10')
 */
export interface IssueSearchDetails {
  status_name: string;
  status_category: string;
  project_key: string;
  assignee_name: string;
  reporter_name: string;
  sprint_name: string;
  epic_key: string;
}
