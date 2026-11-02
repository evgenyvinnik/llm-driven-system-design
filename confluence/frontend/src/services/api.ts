import type {
  User,
  Space,
  Page,
  PageTreeNode,
  PageVersion,
  DiffResult,
  Comment,
  Template,
  Approval,
  SearchResult, SpaceAccessInfo } from '../types';

const API_BASE = '/api/v1';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include',
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Auth
/** Registers a new user account with username, email, and password. */
export async function register(username: string, email: string, password: string): Promise<{ user: User }> {
  return request(`${API_BASE}/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ username, email, password }),
  });
}

/** Authenticates a user with username and password. */
export async function login(username: string, password: string): Promise<{ user: User }> {
  return request(`${API_BASE}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

/** Destroys the current session. */
export async function logout(): Promise<void> {
  await request(`${API_BASE}/auth/logout`, { method: 'POST' });
}

/** Retrieves the currently authenticated user. */
export async function getMe(): Promise<{ user: User }> {
  return request(`${API_BASE}/auth/me`);
}

// Spaces
/** Fetches all public spaces with page counts. */
export async function getSpaces(): Promise<{ spaces: Space[] }> {
  return request(`${API_BASE}/spaces`);
}

/** Fetches a single space by its key. */
export async function getSpace(key: string): Promise<{ space: Space; access: SpaceAccessInfo }> {
  return request(`${API_BASE}/spaces/${key}`);
}

/** Creates a new space with key, name, and optional description. */
export async function createSpace(data: { key: string; name: string; description?: string }): Promise<{ space: Space }> {
  return request(`${API_BASE}/spaces`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Pages
/** Fetches recently updated published pages for the dashboard. */
export async function getRecentPages(): Promise<{ pages: Page[] }> {
  return request(`${API_BASE}/pages/recent`);
}

/** Fetches the hierarchical page tree for a space. */
export async function getPageTree(spaceKey: string): Promise<{ tree: PageTreeNode[] }> {
  return request(`${API_BASE}/pages/space/${spaceKey}/tree`);
}

/** Fetches a page by its URL slug within a space. */
export async function getPageBySlug(spaceKey: string, slug: string): Promise<{ page: Page }> {
  return request(`${API_BASE}/pages/space/${spaceKey}/slug/${slug}`);
}

/** Fetches a page by its unique ID. */
export async function getPageById(id: string): Promise<{ page: Page }> {
  return request(`${API_BASE}/pages/${id}`);
}

/** Creates a new page in a space with content and optional parent. */
export async function createPage(data: {
  spaceId: string;
  title: string;
  contentJson?: object;
  contentHtml?: string;
  contentText?: string;
  parentId?: string;
  status?: string;
}): Promise<{ page: Page }> {
  return request(`${API_BASE}/pages`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** Updates an existing page with new title, content, and change message. */
export async function updatePage(
  id: string,
  data: {
    title: string;
    contentJson?: object;
    contentHtml?: string;
    contentText?: string;
    changeMessage?: string;
    /** The version this edit was based on; the server refuses (409) if it moved on. */
    version?: number;
  },
): Promise<{ page: Page }> {
  return request(`${API_BASE}/pages/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/** Deletes a page by ID. */
export async function deletePage(id: string): Promise<void> {
  await request(`${API_BASE}/pages/${id}`, { method: 'DELETE' });
}

/** Adds a label to a page. */
export async function addLabel(pageId: string, label: string): Promise<void> {
  await request(`${API_BASE}/pages/${pageId}/labels`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  });
}

/** Removes a label from a page. */
export async function removeLabel(pageId: string, label: string): Promise<void> {
  await request(`${API_BASE}/pages/${pageId}/labels/${label}`, { method: 'DELETE' });
}

// Versions
/** Fetches version history for a page. */
export async function getVersionHistory(pageId: string): Promise<{ versions: PageVersion[] }> {
  return request(`${API_BASE}/versions/${pageId}`);
}

/** Fetches a line-by-line diff between two page versions. */
export async function getVersionDiff(
  pageId: string,
  fromVersion: number,
  toVersion: number,
): Promise<{ diff: DiffResult }> {
  return request(`${API_BASE}/versions/${pageId}/diff?from=${fromVersion}&to=${toVersion}`);
}

/** Restores a page to a previous version. */
export async function restoreVersion(pageId: string, versionNumber: number): Promise<void> {
  await request(`${API_BASE}/versions/${pageId}/restore`, {
    method: 'POST',
    body: JSON.stringify({ versionNumber }),
  });
}

// Search
/** Searches published pages with optional space filter. */
export async function searchPages(
  query: string,
  spaceKey?: string,
): Promise<{ results: SearchResult[]; total: number; took: number }> {
  const params = new URLSearchParams({ q: query });
  if (spaceKey) params.set('space', spaceKey);
  return request(`${API_BASE}/search?${params}`);
}

// Comments
/** Fetches threaded comments for a page. */
export async function getComments(pageId: string): Promise<{ comments: Comment[] }> {
  return request(`${API_BASE}/comments/page/${pageId}`);
}

/** Adds a comment to a page, optionally as a reply to a parent comment. */
export async function addComment(pageId: string, content: string, parentId?: string): Promise<{ comment: Comment }> {
  return request(`${API_BASE}/comments/page/${pageId}`, {
    method: 'POST',
    body: JSON.stringify({ content, parentId }),
  });
}

/** Deletes a comment by ID. */
export async function deleteComment(id: string): Promise<void> {
  await request(`${API_BASE}/comments/${id}`, { method: 'DELETE' });
}

/** Toggles the resolved status of a comment. */
export async function resolveComment(id: string): Promise<{ comment: Comment }> {
  return request(`${API_BASE}/comments/${id}/resolve`, { method: 'POST' });
}

// Templates
/** Fetches available templates, optionally filtered by space. */
export async function getTemplates(spaceId?: string): Promise<{ templates: Template[] }> {
  const params = spaceId ? `?spaceId=${spaceId}` : '';
  return request(`${API_BASE}/templates${params}`);
}

// Approvals
/** Submits a page approval request. */
export async function requestApproval(pageId: string): Promise<{ approval: Approval }> {
  return request(`${API_BASE}/approvals/request`, {
    method: 'POST',
    body: JSON.stringify({ pageId }),
  });
}

/** Approves or rejects a pending page approval with optional comment. */
export async function reviewApproval(
  id: string,
  status: 'approved' | 'rejected',
  comment?: string,
): Promise<{ approval: Approval }> {
  return request(`${API_BASE}/approvals/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ status, comment }),
  });
}

/** Fetches all pending approval requests. */
export async function getPendingApprovals(): Promise<{ approvals: Approval[] }> {
  return request(`${API_BASE}/approvals/pending`);
}

/** Fetches all approvals for a specific page. */
export async function getPageApprovals(
  pageId: string,
): Promise<{ approvals: Approval[]; canReview: boolean }> {
  return request(`${API_BASE}/approvals/page/${pageId}`);
}
