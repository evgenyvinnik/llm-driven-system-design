import { query } from '../config/database.js';
import { cacheGet, cacheSet, cacheDel } from '../config/redis.js';
import {
  Workflow,
  WorkflowWithStatuses,
  Status,
  Transition,
  TransitionCondition,
  TransitionValidator,
  TransitionPostFunction,
  Issue,
  User,
} from '../types/index.js';

/** Cache TTL for workflow data in seconds (1 hour) */
const WORKFLOW_CACHE_TTL = 3600;

/**
 * Retrieves a workflow by ID with all statuses and transitions.
 * Results are cached in Redis to avoid repeated database queries.
 *
 * @param workflowId - ID of the workflow
 * @returns Workflow with statuses and transitions, or null if not found
 */
export async function getWorkflow(workflowId: number): Promise<WorkflowWithStatuses | null> {
  const cacheKey = `workflow:${workflowId}`;
  const cached = await cacheGet<WorkflowWithStatuses>(cacheKey);
  if (cached) return cached;

  const { rows: workflows } = await query<Workflow>(
    'SELECT * FROM workflows WHERE id = $1',
    [workflowId]
  );

  if (workflows.length === 0) return null;

  const workflow = workflows[0];

  // Get statuses
  const { rows: statuses } = await query<Status>(
    'SELECT * FROM statuses WHERE workflow_id = $1 ORDER BY position',
    [workflowId]
  );

  // Get transitions
  const { rows: transitions } = await query<Transition>(
    'SELECT * FROM transitions WHERE workflow_id = $1',
    [workflowId]
  );

  const result: WorkflowWithStatuses = {
    ...workflow,
    statuses,
    transitions: transitions.map((t) => ({
      ...t,
      conditions: t.conditions as unknown as TransitionCondition[],
      validators: t.validators as unknown as TransitionValidator[],
      post_functions: t.post_functions as unknown as TransitionPostFunction[],
    })),
  };

  await cacheSet(cacheKey, result, WORKFLOW_CACHE_TTL);
  return result;
}

/**
 * Retrieves the workflow assigned to a project.
 *
 * @param projectId - UUID of the project
 * @returns Workflow with statuses and transitions, or null if not found
 */
export async function getWorkflowByProject(projectId: string): Promise<WorkflowWithStatuses | null> {
  const { rows } = await query<{ workflow_id: number }>(
    'SELECT workflow_id FROM projects WHERE id = $1',
    [projectId]
  );

  if (rows.length === 0) return null;
  return getWorkflow(rows[0].workflow_id);
}

/**
 * Gets all transitions available for an issue from its current status.
 * Checks transition conditions against the user and their project roles.
 * The list only decides which buttons to render; executing a transition evaluates the
 * same rules again, so a stale list can never authorize anything.
 *
 * @param issue - The issue to get transitions for
 * @param user - User requesting the transitions
 * @param projectRoles - Roles the user has in the project
 * @returns Array of available transitions
 */
export async function getAvailableTransitions(
  issue: Issue,
  user: User,
  projectRoles: string[]
): Promise<Transition[]> {
  const workflow = await getWorkflowByProject(issue.project_id);
  if (!workflow) return [];

  return workflow.transitions.filter(
    (transition) =>
      (transition.from_status_id === null || transition.from_status_id === issue.status_id) &&
      evaluateConditions(transition.conditions, issue, user, projectRoles) === null
  );
}

/**
 * Evaluates a transition's conditions: may this user attempt it?
 * Returns null when every condition passes, otherwise the reason it is blocked.
 * Fails closed: a condition type the engine cannot evaluate (unknown type, or groups,
 * which this project has no directory for) blocks the transition instead of allowing it.
 *
 * @param conditions - Conditions configured on the transition
 * @param issue - Issue being transitioned
 * @param user - User attempting the transition
 * @param projectRoles - User's roles in the project
 */
export function evaluateConditions(
  conditions: TransitionCondition[],
  issue: Issue,
  user: User,
  projectRoles: string[]
): string | null {
  for (const condition of conditions) {
    switch (condition.type) {
      case 'always':
        break;
      case 'user_in_role': {
        const role = String(condition.config?.role ?? '');
        if (!projectRoles.includes(role)) return `Only users with the ${role} role can do this`;
        break;
      }
      case 'issue_assignee':
        if (issue.assignee_id !== user.id) return 'Only the assignee can do this';
        break;
      case 'user_in_group':
        return 'Group conditions are not supported, so this transition is blocked';
      default:
        return `Unknown condition "${(condition as { type: string }).type}" blocks this transition`;
    }
  }
  return null;
}

/** Issue fields a validator may inspect. */
const VALIDATABLE_FIELDS = new Set([
  'summary', 'description', 'issue_type', 'priority', 'assignee_id', 'reporter_id',
  'epic_id', 'sprint_id', 'story_points', 'labels', 'components',
]);

function readField(issue: Issue, field: string): unknown {
  if (field.startsWith('custom_fields.')) {
    return issue.custom_fields?.[field.slice('custom_fields.'.length)];
  }
  return VALIDATABLE_FIELDS.has(field) ? (issue as unknown as Record<string, unknown>)[field] : undefined;
}

/**
 * Evaluates a transition's validators against the issue as stored: is it fit to move?
 * Returns null when all pass, otherwise the failing field and message (answered with 422
 * so the client can point at the field). Unknown validator types fail closed.
 *
 * @param validators - Validators configured on the transition
 * @param issue - Issue being transitioned
 */
export function evaluateValidators(
  validators: TransitionValidator[],
  issue: Issue
): { field: string; message: string } | null {
  for (const validator of validators) {
    const field = String(validator.config?.field ?? '');
    switch (validator.type) {
      case 'field_required': {
        const value = readField(issue, field);
        const empty =
          value === null ||
          value === undefined ||
          (typeof value === 'string' && value.trim() === '') ||
          (Array.isArray(value) && value.length === 0);
        if (empty) return { field, message: `${field} is required for this transition` };
        break;
      }
      case 'field_value': {
        const expected = validator.config?.value;
        if (readField(issue, field) !== expected) {
          return { field, message: `${field} must be ${JSON.stringify(expected)} for this transition` };
        }
        break;
      }
      default:
        return { field, message: `Unknown validator "${validator.type}" blocks this transition` };
    }
  }
  return null;
}

/**
 * Creates a new workflow definition.
 *
 * @param name - Workflow name
 * @param description - Optional description
 * @returns Newly created workflow
 */
export async function createWorkflow(
  name: string,
  description?: string
): Promise<Workflow> {
  const { rows } = await query<Workflow>(
    `INSERT INTO workflows (name, description) VALUES ($1, $2) RETURNING *`,
    [name, description]
  );
  return rows[0];
}

/**
 * Creates a status in a workflow.
 * Invalidates the workflow cache.
 *
 * @param workflowId - ID of the workflow
 * @param name - Status name
 * @param category - Status category (todo, in_progress, done)
 * @param color - Hex color code
 * @param position - Sort position
 * @returns Newly created status
 */
export async function createStatus(
  workflowId: number,
  name: string,
  category: 'todo' | 'in_progress' | 'done',
  color: string,
  position: number
): Promise<Status> {
  const { rows } = await query<Status>(
    `INSERT INTO statuses (workflow_id, name, category, color, position)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [workflowId, name, category, color, position]
  );

  await cacheDel(`workflow:${workflowId}`);
  return rows[0];
}

/** Thrown when a workflow definition is invalid; routes answer it with 422. */
export class WorkflowDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowDefinitionError';
  }
}

const CONDITION_TYPES = new Set(['always', 'user_in_role', 'issue_assignee']);
const VALIDATOR_TYPES = new Set(['field_required', 'field_value']);
const POST_FUNCTION_TYPES = new Set(['assign_to_current_user', 'clear_field', 'update_field', 'send_notification']);

/**
 * Checks transition rules when the workflow is saved, so a typo in an admin's config is
 * rejected once instead of blocking every issue that later tries the transition.
 * Returns the problems found (empty when valid).
 */
export function findRuleProblems(
  conditions: TransitionCondition[],
  validators: TransitionValidator[],
  postFunctions: TransitionPostFunction[]
): string[] {
  const problems: string[] = [];
  for (const c of conditions) {
    if (!CONDITION_TYPES.has(c?.type)) problems.push(`Unsupported condition "${c?.type}"`);
  }
  for (const v of validators) {
    if (!VALIDATOR_TYPES.has(v?.type)) problems.push(`Unsupported validator "${v?.type}"`);
    else if (!v.config?.field) problems.push(`Validator "${v.type}" needs config.field`);
  }
  for (const p of postFunctions) {
    if (!POST_FUNCTION_TYPES.has(p?.type)) problems.push(`Unsupported post-function "${p?.type}"`);
  }
  return problems;
}

/**
 * Creates a transition between statuses in a workflow.
 * Rejects definitions that would strand issues: both statuses must belong to this
 * workflow and every rule type must be one the engine can evaluate.
 * Invalidates the workflow cache.
 *
 * @param workflowId - ID of the workflow
 * @param name - Transition name (displayed to users)
 * @param fromStatusId - Source status ID (null = from any)
 * @param toStatusId - Target status ID
 * @param conditions - Array of conditions to check
 * @param validators - Array of validators to run
 * @param postFunctions - Array of post-functions to execute
 * @returns Newly created transition
 * @throws WorkflowDefinitionError - If the definition is invalid
 */
export async function createTransition(
  workflowId: number,
  name: string,
  fromStatusId: number | null,
  toStatusId: number,
  conditions: TransitionCondition[] = [],
  validators: TransitionValidator[] = [],
  postFunctions: TransitionPostFunction[] = []
): Promise<Transition> {
  const problems = findRuleProblems(conditions, validators, postFunctions);
  const statusIds = [toStatusId, ...(fromStatusId === null ? [] : [fromStatusId])];
  const { rows: owned } = await query<{ id: number }>(
    'SELECT id FROM statuses WHERE workflow_id = $1 AND id = ANY($2::int[])',
    [workflowId, statusIds]
  );
  if (owned.length !== new Set(statusIds).size) {
    problems.push('Both statuses must belong to this workflow');
  }
  if (problems.length > 0) {
    throw new WorkflowDefinitionError(problems.join('; '));
  }

  const { rows } = await query<Transition>(
    `INSERT INTO transitions (workflow_id, name, from_status_id, to_status_id, conditions, validators, post_functions)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [workflowId, name, fromStatusId, toStatusId, JSON.stringify(conditions), JSON.stringify(validators), JSON.stringify(postFunctions)]
  );

  await cacheDel(`workflow:${workflowId}`);
  return rows[0];
}

/**
 * Retrieves all workflow definitions.
 *
 * @returns Array of all workflows
 */
export async function getAllWorkflows(): Promise<Workflow[]> {
  const { rows } = await query<Workflow>('SELECT * FROM workflows ORDER BY name');
  return rows;
}

/**
 * Retrieves all statuses for a workflow.
 *
 * @param workflowId - ID of the workflow
 * @returns Array of statuses ordered by position
 */
export async function getStatuses(workflowId: number): Promise<Status[]> {
  const { rows } = await query<Status>(
    'SELECT * FROM statuses WHERE workflow_id = $1 ORDER BY position',
    [workflowId]
  );
  return rows;
}

/**
 * Retrieves a status by its ID.
 *
 * @param statusId - ID of the status
 * @returns Status or null if not found
 */
export async function getStatus(statusId: number): Promise<Status | null> {
  const { rows } = await query<Status>('SELECT * FROM statuses WHERE id = $1', [statusId]);
  return rows[0] || null;
}

/**
 * Updates a status definition.
 * Invalidates the workflow cache.
 *
 * @param statusId - ID of the status to update
 * @param updates - Partial status data to update
 * @returns Updated status or null if not found
 */
export async function updateStatus(
  statusId: number,
  updates: Partial<Pick<Status, 'name' | 'category' | 'color' | 'position'>>
): Promise<Status | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.category !== undefined) {
    fields.push(`category = $${paramIndex++}`);
    values.push(updates.category);
  }
  if (updates.color !== undefined) {
    fields.push(`color = $${paramIndex++}`);
    values.push(updates.color);
  }
  if (updates.position !== undefined) {
    fields.push(`position = $${paramIndex++}`);
    values.push(updates.position);
  }

  if (fields.length === 0) return null;

  values.push(statusId);

  const { rows } = await query<Status>(
    `UPDATE statuses SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  if (rows[0]) {
    await cacheDel(`workflow:${rows[0].workflow_id}`);
  }

  return rows[0] || null;
}
