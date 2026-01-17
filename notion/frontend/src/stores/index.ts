import { create } from 'zustand';
import type { User, Workspace, Page } from '@/types';
import { authApi, workspacesApi, pagesApi } from '@/services/api';
import { wsService } from '@/services/websocket';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem('token'),
  isLoading: true,
  isAuthenticated: false,

  login: async (email, password) => {
    const { user, token } = await authApi.login(email, password);
    localStorage.setItem('token', token);
    wsService.connect(token);
    set({ user, token, isAuthenticated: true });
  },

  register: async (email, password, name) => {
    const { user, token } = await authApi.register(email, password, name);
    localStorage.setItem('token', token);
    wsService.connect(token);
    set({ user, token, isAuthenticated: true });
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore errors on logout
    }
    localStorage.removeItem('token');
    wsService.disconnect();
    set({ user: null, token: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    const token = get().token;
    if (!token) {
      set({ isLoading: false, isAuthenticated: false });
      return;
    }

    try {
      const { user } = await authApi.me();
      wsService.connect(token);
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      localStorage.removeItem('token');
      set({ user: null, token: null, isAuthenticated: false, isLoading: false });
    }
  },
}));

interface WorkspaceState {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  isLoading: boolean;
  fetchWorkspaces: () => Promise<void>;
  setCurrentWorkspace: (workspace: Workspace) => void;
  createWorkspace: (name: string, icon?: string) => Promise<Workspace>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  currentWorkspace: null,
  isLoading: false,

  fetchWorkspaces: async () => {
    set({ isLoading: true });
    try {
      const { workspaces } = await workspacesApi.list();
      set({ workspaces, isLoading: false });

      // Set first workspace as current if none selected
      if (!get().currentWorkspace && workspaces.length > 0) {
        set({ currentWorkspace: workspaces[0] });
      }
    } catch (error) {
      console.error('Failed to fetch workspaces:', error);
      set({ isLoading: false });
    }
  },

  setCurrentWorkspace: (workspace) => {
    set({ currentWorkspace: workspace });
  },

  createWorkspace: async (name, icon) => {
    const { workspace } = await workspacesApi.create(name, icon);
    set((state) => ({
      workspaces: [...state.workspaces, workspace],
      currentWorkspace: workspace,
    }));
    return workspace;
  },
}));

interface PageState {
  pages: Page[];
  currentPage: Page | null;
  isLoading: boolean;
  expandedPages: Set<string>;
  fetchPages: (workspaceId: string) => Promise<void>;
  setCurrentPage: (page: Page | null) => void;
  createPage: (data: {
    workspace_id: string;
    parent_id?: string | null;
    title?: string;
    icon?: string;
    is_database?: boolean;
  }) => Promise<Page>;
  updatePage: (id: string, data: Partial<Page>) => Promise<void>;
  deletePage: (id: string) => Promise<void>;
  toggleExpanded: (pageId: string) => void;
}

export const usePageStore = create<PageState>((set, get) => ({
  pages: [],
  currentPage: null,
  isLoading: false,
  expandedPages: new Set(),

  fetchPages: async (workspaceId) => {
    set({ isLoading: true });
    try {
      const { pages } = await pagesApi.list(workspaceId);
      set({ pages, isLoading: false });
    } catch (error) {
      console.error('Failed to fetch pages:', error);
      set({ isLoading: false });
    }
  },

  setCurrentPage: (page) => {
    set({ currentPage: page });
  },

  createPage: async (data) => {
    const { page } = await pagesApi.create(data);
    set((state) => ({
      pages: [...state.pages, page],
    }));

    // Expand parent if exists
    if (page.parent_id) {
      set((state) => ({
        expandedPages: new Set([...state.expandedPages, page.parent_id!]),
      }));
    }

    return page;
  },

  updatePage: async (id, data) => {
    const { page } = await pagesApi.update(id, data);
    set((state) => ({
      pages: state.pages.map((p) => (p.id === id ? page : p)),
      currentPage: state.currentPage?.id === id ? page : state.currentPage,
    }));
  },

  deletePage: async (id) => {
    await pagesApi.delete(id);
    set((state) => ({
      pages: state.pages.filter((p) => p.id !== id),
      currentPage: state.currentPage?.id === id ? null : state.currentPage,
    }));
  },

  toggleExpanded: (pageId) => {
    set((state) => {
      const newExpanded = new Set(state.expandedPages);
      if (newExpanded.has(pageId)) {
        newExpanded.delete(pageId);
      } else {
        newExpanded.add(pageId);
      }
      return { expandedPages: newExpanded };
    });
  },
}));
