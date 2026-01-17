import type { User, Project, IssueWithDetails, Sprint, Workflow, Board, Label, Comment, IssueHistory, Transition, SearchResult, Aggregations } from '../types';

const API_BASE = '/api';

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

// Auth
export async function login(email: string, password: string): Promise<User> {
  const data = await fetchApi<{ user: User }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return data.user;
}

export async function logout(): Promise<void> {
  await fetchApi('/auth/logout', { method: 'POST' });
}

export async function register(email: string, password: string, name: string): Promise<User> {
  const data = await fetchApi<{ user: User }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });
  return data.user;
}

export async function getCurrentUser(): Promise<User | null> {
  try {
    const data = await fetchApi<{ user: User }>('/auth/me');
    return data.user;
  } catch {
    return null;
  }
}

export async function getUsers(): Promise<User[]> {
  const data = await fetchApi<{ users: User[] }>('/users');
  return data.users;
}

// Projects
export async function getProjects(): Promise<Project[]> {
  const data = await fetchApi<{ projects: Project[] }>('/projects');
  return data.projects;
}

export async function getProject(idOrKey: string): Promise<Project> {
  const data = await fetchApi<{ project: Project }>(`/projects/${idOrKey}`);
  return data.project;
}

export async function createProject(projectData: { key: string; name: string; description?: string }): Promise<Project> {
  const data = await fetchApi<{ project: Project }>('/projects', {
    method: 'POST',
    body: JSON.stringify(projectData),
  });
  return data.project;
}

// Issues
export async function getIssue(idOrKey: string | number): Promise<IssueWithDetails> {
  const data = await fetchApi<{ issue: IssueWithDetails }>(`/issues/${idOrKey}`);
  return data.issue;
}

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

export async function deleteIssue(issueId: number): Promise<void> {
  await fetchApi(`/issues/${issueId}`, { method: 'DELETE' });
}

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

export async function getBacklogIssues(projectId: string): Promise<IssueWithDetails[]> {
  const data = await fetchApi<{ issues: IssueWithDetails[] }>(`/issues/project/${projectId}/backlog`);
  return data.issues;
}

export async function getSprintIssues(sprintId: number): Promise<IssueWithDetails[]> {
  const data = await fetchApi<{ issues: IssueWithDetails[] }>(`/issues/sprint/${sprintId}`);
  return data.issues;
}

// Transitions
export async function getIssueTransitions(issueId: number): Promise<Transition[]> {
  const data = await fetchApi<{ transitions: Transition[] }>(`/issues/${issueId}/transitions`);
  return data.transitions;
}

export async function executeTransition(issueId: number, transitionId: number): Promise<IssueWithDetails> {
  const data = await fetchApi<{ issue: IssueWithDetails }>(`/issues/${issueId}/transitions/${transitionId}`, {
    method: 'POST',
  });
  return data.issue;
}

// Comments
export async function getIssueComments(issueId: number): Promise<Comment[]> {
  const data = await fetchApi<{ comments: Comment[] }>(`/issues/${issueId}/comments`);
  return data.comments;
}

export async function addComment(issueId: number, body: string): Promise<Comment> {
  const data = await fetchApi<{ comment: Comment }>(`/issues/${issueId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return data.comment;
}

// History
export async function getIssueHistory(issueId: number): Promise<IssueHistory[]> {
  const data = await fetchApi<{ history: IssueHistory[] }>(`/issues/${issueId}/history`);
  return data.history;
}

// Sprints
export async function getProjectSprints(projectId: string): Promise<Sprint[]> {
  const data = await fetchApi<{ sprints: Sprint[] }>(`/projects/${projectId}/sprints`);
  return data.sprints;
}

export async function createSprint(projectId: string, name: string, goal?: string): Promise<Sprint> {
  const data = await fetchApi<{ sprint: Sprint }>(`/projects/${projectId}/sprints`, {
    method: 'POST',
    body: JSON.stringify({ name, goal }),
  });
  return data.sprint;
}

export async function startSprint(sprintId: number): Promise<Sprint> {
  const data = await fetchApi<{ sprint: Sprint }>(`/workflows/sprints/${sprintId}/start`, {
    method: 'POST',
  });
  return data.sprint;
}

export async function completeSprint(sprintId: number): Promise<Sprint> {
  const data = await fetchApi<{ sprint: Sprint }>(`/workflows/sprints/${sprintId}/complete`, {
    method: 'POST',
  });
  return data.sprint;
}

// Workflows
export async function getProjectWorkflow(projectId: string): Promise<Workflow> {
  const data = await fetchApi<{ workflow: Workflow }>(`/workflows/project/${projectId}`);
  return data.workflow;
}

// Boards
export async function getProjectBoards(projectId: string): Promise<Board[]> {
  const data = await fetchApi<{ boards: Board[] }>(`/projects/${projectId}/boards`);
  return data.boards;
}

export async function getBoard(boardId: number): Promise<Board> {
  const data = await fetchApi<{ board: Board }>(`/workflows/boards/${boardId}`);
  return data.board;
}

// Labels
export async function getProjectLabels(projectId: string): Promise<Label[]> {
  const data = await fetchApi<{ labels: Label[] }>(`/projects/${projectId}/labels`);
  return data.labels;
}

// Search
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

export async function quickSearch(query: string, projectId?: string): Promise<IssueWithDetails[]> {
  const params = new URLSearchParams({ q: query });
  if (projectId) params.set('projectId', projectId);

  const data = await fetchApi<{ issues: IssueWithDetails[] }>(`/search/quick?${params.toString()}`);
  return data.issues;
}

export async function getAggregations(projectId?: string): Promise<Aggregations> {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);

  const data = await fetchApi<{ aggregations: Aggregations }>(`/search/aggregations?${params.toString()}`);
  return data.aggregations;
}
