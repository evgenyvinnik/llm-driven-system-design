const API_BASE = '/api';

class ApiClient {
  private sessionId: string | null = null;

  constructor() {
    this.sessionId = localStorage.getItem('sessionId');
  }

  setSession(sessionId: string | null) {
    this.sessionId = sessionId;
    if (sessionId) {
      localStorage.setItem('sessionId', sessionId);
    } else {
      localStorage.removeItem('sessionId');
    }
  }

  private async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.sessionId) {
      headers['X-Session-Id'] = this.sessionId;
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }

    return response.json();
  }

  // Auth
  async login(username: string, password: string) {
    const result = await this.fetch<{ sessionId: string; user: any }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    this.setSession(result.sessionId);
    return result;
  }

  async register(username: string, email: string, password: string, displayName?: string) {
    const result = await this.fetch<{ sessionId: string; user: any }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, displayName }),
    });
    this.setSession(result.sessionId);
    return result;
  }

  async logout() {
    await this.fetch('/auth/logout', { method: 'POST' });
    this.setSession(null);
  }

  async getCurrentUser() {
    return this.fetch<{ user: any }>('/auth/me');
  }

  // Repositories
  async getRepos(params?: { owner?: string; page?: number; limit?: number; sort?: string }) {
    const query = new URLSearchParams(params as Record<string, string>).toString();
    return this.fetch<{ repos: any[]; total: number }>(`/repos?${query}`);
  }

  async getRepo(owner: string, repo: string) {
    return this.fetch<any>(`/repos/${owner}/${repo}`);
  }

  async createRepo(data: { name: string; description?: string; isPrivate?: boolean; initWithReadme?: boolean }) {
    return this.fetch<any>('/repos', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteRepo(owner: string, repo: string) {
    return this.fetch<{ success: boolean }>(`/repos/${owner}/${repo}`, {
      method: 'DELETE',
    });
  }

  async getTree(owner: string, repo: string, ref: string, path?: string) {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.fetch<any[]>(`/repos/${owner}/${repo}/tree/${ref}${query}`);
  }

  async getFileContent(owner: string, repo: string, ref: string, path: string) {
    return this.fetch<{ path: string; content: string }>(`/repos/${owner}/${repo}/blob/${ref}/${path}`);
  }

  async getCommits(owner: string, repo: string, branch?: string, page?: number) {
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    if (page) params.set('page', String(page));
    return this.fetch<any[]>(`/repos/${owner}/${repo}/commits?${params}`);
  }

  async getCommit(owner: string, repo: string, sha: string) {
    return this.fetch<any>(`/repos/${owner}/${repo}/commit/${sha}`);
  }

  async getBranches(owner: string, repo: string) {
    return this.fetch<any[]>(`/repos/${owner}/${repo}/branches`);
  }

  async starRepo(owner: string, repo: string) {
    return this.fetch<{ starred: boolean }>(`/repos/${owner}/${repo}/star`, { method: 'POST' });
  }

  async unstarRepo(owner: string, repo: string) {
    return this.fetch<{ starred: boolean }>(`/repos/${owner}/${repo}/star`, { method: 'DELETE' });
  }

  async isStarred(owner: string, repo: string) {
    return this.fetch<{ starred: boolean }>(`/repos/${owner}/${repo}/starred`);
  }

  // Pull Requests
  async getPulls(owner: string, repo: string, state?: string, page?: number) {
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (page) params.set('page', String(page));
    return this.fetch<{ pulls: any[]; total: number }>(`/${owner}/${repo}/pulls?${params}`);
  }

  async getPull(owner: string, repo: string, number: number) {
    return this.fetch<any>(`/${owner}/${repo}/pulls/${number}`);
  }

  async getPullDiff(owner: string, repo: string, number: number) {
    return this.fetch<{ diff: string; stats: any }>(`/${owner}/${repo}/pulls/${number}/diff`);
  }

  async createPull(owner: string, repo: string, data: { title: string; body?: string; headBranch: string; baseBranch: string; isDraft?: boolean }) {
    return this.fetch<any>(`/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async mergePull(owner: string, repo: string, number: number, strategy?: string, message?: string) {
    return this.fetch<{ merged: boolean; sha: string }>(`/${owner}/${repo}/pulls/${number}/merge`, {
      method: 'POST',
      body: JSON.stringify({ strategy, message }),
    });
  }

  async addReview(owner: string, repo: string, number: number, state: string, body?: string) {
    return this.fetch<any>(`/${owner}/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ state, body }),
    });
  }

  async getPullComments(owner: string, repo: string, number: number) {
    return this.fetch<any[]>(`/${owner}/${repo}/pulls/${number}/comments`);
  }

  async addPullComment(owner: string, repo: string, number: number, body: string) {
    return this.fetch<any>(`/${owner}/${repo}/pulls/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  // Issues
  async getIssues(owner: string, repo: string, params?: { state?: string; label?: string; assignee?: string; page?: number }) {
    const query = new URLSearchParams(params as Record<string, string>).toString();
    return this.fetch<{ issues: any[]; total: number }>(`/${owner}/${repo}/issues?${query}`);
  }

  async getIssue(owner: string, repo: string, number: number) {
    return this.fetch<any>(`/${owner}/${repo}/issues/${number}`);
  }

  async createIssue(owner: string, repo: string, data: { title: string; body?: string; labels?: string[]; assignee?: string }) {
    return this.fetch<any>(`/${owner}/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateIssue(owner: string, repo: string, number: number, data: { title?: string; body?: string; state?: string; assignee?: string; labels?: string[] }) {
    return this.fetch<any>(`/${owner}/${repo}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async addIssueComment(owner: string, repo: string, number: number, body: string) {
    return this.fetch<any>(`/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async getLabels(owner: string, repo: string) {
    return this.fetch<any[]>(`/${owner}/${repo}/labels`);
  }

  // Discussions
  async getDiscussions(owner: string, repo: string, category?: string, page?: number) {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (page) params.set('page', String(page));
    return this.fetch<{ discussions: any[]; total: number }>(`/${owner}/${repo}/discussions?${params}`);
  }

  async getDiscussion(owner: string, repo: string, number: number) {
    return this.fetch<any>(`/${owner}/${repo}/discussions/${number}`);
  }

  async createDiscussion(owner: string, repo: string, data: { title: string; body: string; category?: string }) {
    return this.fetch<any>(`/${owner}/${repo}/discussions`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async addDiscussionComment(owner: string, repo: string, number: number, body: string, parentId?: number) {
    return this.fetch<any>(`/${owner}/${repo}/discussions/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, parentId }),
    });
  }

  // Users
  async getUser(username: string) {
    return this.fetch<any>(`/users/${username}`);
  }

  async updateProfile(data: { displayName?: string; bio?: string; location?: string; company?: string; website?: string }) {
    return this.fetch<any>('/users/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async getUserRepos(username: string, sort?: string) {
    const params = sort ? `?sort=${sort}` : '';
    return this.fetch<any[]>(`/users/${username}/repos${params}`);
  }

  async getUserStarred(username: string) {
    return this.fetch<any[]>(`/users/${username}/starred`);
  }

  // Search
  async searchCode(query: string, filters?: { language?: string; repo?: string; owner?: string; path?: string }) {
    const params = new URLSearchParams({ q: query, ...filters });
    return this.fetch<{ total: number; results: any[] }>(`/search/code?${params}`);
  }

  async search(query: string, type?: string) {
    const params = new URLSearchParams({ q: query });
    if (type) params.set('type', type);
    return this.fetch<{ repositories: any[]; issues: any[]; users: any[] }>(`/search?${params}`);
  }
}

export const api = new ApiClient();
