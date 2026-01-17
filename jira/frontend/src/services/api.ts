/**
 * API client for the Jira clone backend.
 * Provides typed functions for all API endpoints with automatic error handling.
 */

import type { User, Project, IssueWithDetails, Sprint, Workflow, Board, Label, Comment, IssueHistory, Transition, SearchResult, Aggregations } from '../types';

/** Base URL for API requests */
const API_BASE = '/api';

/**
 * Generic fetch wrapper with error handling and JSON parsing.
 * Automatically includes credentials and content-type headers.
 *
 * @template T - Expected response type
 * @param endpoint - API endpoint path (e.g., "/projects")
 * @param options - Fetch options (method, body, headers, etc.)
 * @returns Parsed JSON response
 * @throws Error with server error message on failure
 */
async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

/**
 * Authenticates a user with email and password.
 * Creates a session on the server.
 *
 * @param email - User's email address
 * @param password - User's password
 * @returns Authenticated user object
 */
export async function login(email: string, password: string): Promise<User> {
  const data = await fetchApi<{ user: User }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return data.user;
}

/**
 * Logs out the current user.
 * Destroys the server session.
 */
export async function logout(): Promise<void> {
  await fetchApi('/auth/logout', { method: 'POST' });
}

/**
 * Registers a new user account.
 * Automatically logs in the user after registration.
 *
 * @param email - User's email address
 * @param password - User's password
 * @param name - User's display name
 * @returns Newly created user object
 */
export async function register(email: string, password: string, name: string): Promise<User> {
  const data = await fetchApi<{ user: User }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });
  return data.user;
}

/**
 * Gets the currently authenticated user from the session.
 *
 * @returns User object if authenticated, null otherwise
 */
export async function getCurrentUser(): Promise<User | null> {
  try {
    const data = await fetchApi<{ user: User }>('/auth/me');
    return data.user;
  } catch {
    return null;
  }
}

/**
 * Gets all users for dropdown menus.
 *
 * @returns Array of all users
 */
export async function getUsers(): Promise<User[]> {
  const data = await fetchApi<{ users: User[] }>('/users');
  return data.users;
}

/**
 * Gets all projects.
 *
 * @returns Array of all projects
 */
export async function getProjects(): Promise<Project[]> {
  const data = await fetchApi<{ projects: Project[] }>('/projects');
  return data.projects;
}

/**
 * Gets a project by ID or key.
 *
 * @param idOrKey - Project UUID or key (e.g., "PROJ")
 * @returns Project object
 */
export async function getProject(idOrKey: string): Promise<Project> {
  const data = await fetchApi<{ project: Project }>(`/projects/${idOrKey}`);
  return data.project;
}

/**
 * Creates a new project.
 *
 * @param projectData - Project creation data
 * @returns Newly created project
 */
export async function createProject(projectData: { key: string; name: string; description?: string }): Promise<Project> {
  const data = await fetchApi<{ project: Project }>('/projects', {
    method: 'POST',
    body: JSON.stringify(projectData),
  });
  return data.project;
}

/**
 * Gets an issue by ID or key.
 *
 * @param idOrKey - Issue ID or key (e.g., "PROJ-123")
 * @returns Issue with full details
 */
export async function getIssue(idOrKey: string | number): Promise<IssueWithDetails> {
  const data = await fetchApi<{ issue: IssueWithDetails }>(`/issues/${idOrKey}`);
  return data.issue;
}

/**
 * Creates a new issue in a project.
 *
 * @param issueData - Issue creation data
 * @returns Newly created issue with full details
 */
export async function createIssue(issueData: {
  projectId: string;
  summary: string;
  description?: string;
  issueType: string;
  priority?: string;
  assigneeId?: string;
  sprintId?: number;
  epicId?: number;
  storyPoints?: number;
  labels?: string[];
}): Promise<IssueWithDetails> {
  const data = await fetchApi<{ issue: IssueWithDetails }>('/issues', {
    method: 'POST',
    body: JSON.stringify(issueData),
  });
  return data.issue;
}

/**
 * Updates an existing issue.
 *
 * @param issueId - ID of the issue to update
 * @param updates - Partial issue data to update
 * @returns Updated issue with full details
 */
export async function updateIssue(
  issueId: number,
  updates: Partial<{
    summary: string;
    description: string;
    priority: string;
    assigneeId: string | null;
    sprintId: number | null;
    epicId: number | null;
    storyPoints: number | null;
    labels: string[];
  }>
): Promise<IssueWithDetails> {
  const data = await fetchApi<{ issue: IssueWithDetails }>(`/issues/${issueId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  return data.issue;
}

/**
 * Deletes an issue.
 *
 * @param issueId - ID of the issue to delete
 */
export async function deleteIssue(issueId: number): Promise<void> {
  await fetchApi(`/issues/${issueId}`, { method: 'DELETE' });
}

/**
 * Gets issues for a project with optional filters.
 *
 * @param projectId - UUID of the project
 * @param options - Filter and pagination options
 * @returns Object with issues array and total count
 */
export async function getProjectIssues(
  projectId: string,
  options?: {
    statusId?: number;
    assigneeId?: string;
    sprintId?: number;
    issueType?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{ issues: IssueWithDetails[]; total: number }> {
  const params = new URLSearchParams();
  if (options?.statusId) params.set('statusId', String(options.statusId));
  if (options?.assigneeId) params.set('assigneeId', options.assigneeId);
  if (options?.sprintId !== undefined) params.set('sprintId', String(options.sprintId));
  if (options?.issueType) params.set('issueType', options.issueType);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));

  return fetchApi(`/issues/project/${projectId}?${params.toString()}`);
}

/**
 * Gets backlog issues (not in any sprint).
 *
 * @param projectId - UUID of the project
 * @returns Array of backlog issues
 */
export async function getBacklogIssues(projectId: string): Promise<IssueWithDetails[]> {
  const data = await fetchApi<{ issues: IssueWithDetails[] }>(`/issues/project/${projectId}/backlog`);
  return data.issues;
}

/**
 * Gets issues assigned to a sprint.
 *
 * @param sprintId - ID of the sprint
 * @returns Array of sprint issues
 */
export async function getSprintIssues(sprintId: number): Promise<IssueWithDetails[]> {
  const data = await fetchApi<{ issues: IssueWithDetails[] }>(`/issues/sprint/${sprintId}`);
  return data.issues;
}

/**
 * Gets available workflow transitions for an issue.
 *
 * @param issueId - ID of the issue
 * @returns Array of available transitions
 */
export async function getIssueTransitions(issueId: number): Promise<Transition[]> {
  const data = await fetchApi<{ transitions: Transition[] }>(`/issues/${issueId}/transitions`);
  return data.transitions;
}

/**
 * Executes a workflow transition on an issue.
 *
 * @param issueId - ID of the issue
 * @param transitionId - ID of the transition to execute
 * @returns Updated issue with new status
 */
export async function executeTransition(issueId: number, transitionId: number): Promise<IssueWithDetails> {
  const data = await fetchApi<{ issue: IssueWithDetails }>(`/issues/${issueId}/transitions/${transitionId}`, {
    method: 'POST',
  });
  return data.issue;
}

/**
 * Gets comments for an issue.
 *
 * @param issueId - ID of the issue
 * @returns Array of comments with author details
 */
export async function getIssueComments(issueId: number): Promise<Comment[]> {
  const data = await fetchApi<{ comments: Comment[] }>(`/issues/${issueId}/comments`);
  return data.comments;
}

/**
 * Adds a comment to an issue.
 *
 * @param issueId - ID of the issue
 * @param body - Comment text
 * @returns Newly created comment
 */
export async function addComment(issueId: number, body: string): Promise<Comment> {
  const data = await fetchApi<{ comment: Comment }>(`/issues/${issueId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return data.comment;
}

/**
 * Gets change history for an issue.
 *
 * @param issueId - ID of the issue
 * @returns Array of history entries
 */
export async function getIssueHistory(issueId: number): Promise<IssueHistory[]> {
  const data = await fetchApi<{ history: IssueHistory[] }>(`/issues/${issueId}/history`);
  return data.history;
}

/**
 * Gets sprints for a project.
 *
 * @param projectId - UUID of the project
 * @returns Array of sprints
 */
export async function getProjectSprints(projectId: string): Promise<Sprint[]> {
  const data = await fetchApi<{ sprints: Sprint[] }>(`/projects/${projectId}/sprints`);
  return data.sprints;
}

/**
 * Creates a new sprint in a project.
 *
 * @param projectId - UUID of the project
 * @param name - Sprint name
 * @param goal - Optional sprint goal
 * @returns Newly created sprint
 */
export async function createSprint(projectId: string, name: string, goal?: string): Promise<Sprint> {
  const data = await fetchApi<{ sprint: Sprint }>(`/projects/${projectId}/sprints`, {
    method: 'POST',
    body: JSON.stringify({ name, goal }),
  });
  return data.sprint;
}

/**
 * Starts a sprint.
 *
 * @param sprintId - ID of the sprint to start
 * @returns Updated sprint with active status
 */
export async function startSprint(sprintId: number): Promise<Sprint> {
  const data = await fetchApi<{ sprint: Sprint }>(`/workflows/sprints/${sprintId}/start`, {
    method: 'POST',
  });
  return data.sprint;
}

/**
 * Completes a sprint.
 *
 * @param sprintId - ID of the sprint to complete
 * @returns Updated sprint with closed status
 */
export async function completeSprint(sprintId: number): Promise<Sprint> {
  const data = await fetchApi<{ sprint: Sprint }>(`/workflows/sprints/${sprintId}/complete`, {
    method: 'POST',
  });
  return data.sprint;
}

/**
 * Gets the workflow for a project.
 *
 * @param projectId - UUID of the project
 * @returns Workflow with statuses and transitions
 */
export async function getProjectWorkflow(projectId: string): Promise<Workflow> {
  const data = await fetchApi<{ workflow: Workflow }>(`/workflows/project/${projectId}`);
  return data.workflow;
}

/**
 * Gets boards for a project.
 *
 * @param projectId - UUID of the project
 * @returns Array of boards
 */
export async function getProjectBoards(projectId: string): Promise<Board[]> {
  const data = await fetchApi<{ boards: Board[] }>(`/projects/${projectId}/boards`);
  return data.boards;
}

/**
 * Gets a board by ID.
 *
 * @param boardId - ID of the board
 * @returns Board configuration
 */
export async function getBoard(boardId: number): Promise<Board> {
  const data = await fetchApi<{ board: Board }>(`/workflows/boards/${boardId}`);
  return data.board;
}

/**
 * Gets labels for a project.
 *
 * @param projectId - UUID of the project
 * @returns Array of labels
 */
export async function getProjectLabels(projectId: string): Promise<Label[]> {
  const data = await fetchApi<{ labels: Label[] }>(`/projects/${projectId}/labels`);
  return data.labels;
}

/**
 * Searches issues using JQL and/or full-text search.
 *
 * @param options - Search parameters
 * @returns Search results with issues, total count, and timing
 */
export async function searchIssues(options: {
  jql?: string;
  text?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
}): Promise<SearchResult> {
  const params = new URLSearchParams();
  if (options.jql) params.set('jql', options.jql);
  if (options.text) params.set('text', options.text);
  if (options.projectId) params.set('projectId', options.projectId);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));

  return fetchApi(`/search?${params.toString()}`);
}

/**
 * Performs a quick text search for type-ahead.
 *
 * @param query - Search text
 * @param projectId - Optional project to scope search
 * @returns Array of matching issues
 */
export async function quickSearch(query: string, projectId?: string): Promise<IssueWithDetails[]> {
  const params = new URLSearchParams({ q: query });
  if (projectId) params.set('projectId', projectId);

  const data = await fetchApi<{ issues: IssueWithDetails[] }>(`/search/quick?${params.toString()}`);
  return data.issues;
}

/**
 * Gets filter aggregations for building filter UI.
 *
 * @param projectId - Optional project to scope aggregations
 * @returns Aggregated counts by status, priority, type, etc.
 */
export async function getAggregations(projectId?: string): Promise<Aggregations> {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);

  const data = await fetchApi<{ aggregations: Aggregations }>(`/search/aggregations?${params.toString()}`);
  return data.aggregations;
}
