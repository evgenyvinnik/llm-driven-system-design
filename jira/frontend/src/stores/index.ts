import { create } from 'zustand';
import type { User, Project, IssueWithDetails, Sprint, Workflow, Board } from '../types';
import * as api from '../services/api';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  login: async (email: string, password: string) => {
    const user = await api.login(email, password);
    set({ user, isAuthenticated: true });
  },

  logout: async () => {
    await api.logout();
    set({ user: null, isAuthenticated: false });
  },

  register: async (email: string, password: string, name: string) => {
    const user = await api.register(email, password, name);
    set({ user, isAuthenticated: true });
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const user = await api.getCurrentUser();
      set({ user, isAuthenticated: !!user, isLoading: false });
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  workflow: Workflow | null;
  sprints: Sprint[];
  boards: Board[];
  isLoading: boolean;
  fetchProjects: () => Promise<void>;
  setCurrentProject: (project: Project | null) => void;
  fetchProjectDetails: (projectId: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  currentProject: null,
  workflow: null,
  sprints: [],
  boards: [],
  isLoading: false,

  fetchProjects: async () => {
    set({ isLoading: true });
    try {
      const projects = await api.getProjects();
      set({ projects, isLoading: false });
    } catch (error) {
      console.error('Failed to fetch projects:', error);
      set({ isLoading: false });
    }
  },

  setCurrentProject: (project) => set({ currentProject: project }),

  fetchProjectDetails: async (projectId: string) => {
    set({ isLoading: true });
    try {
      const [project, workflow, sprints, boards] = await Promise.all([
        api.getProject(projectId),
        api.getProjectWorkflow(projectId),
        api.getProjectSprints(projectId),
        api.getProjectBoards(projectId),
      ]);
      set({
        currentProject: project,
        workflow,
        sprints,
        boards,
        isLoading: false,
      });
    } catch (error) {
      console.error('Failed to fetch project details:', error);
      set({ isLoading: false });
    }
  },
}));

interface IssueState {
  issues: IssueWithDetails[];
  currentIssue: IssueWithDetails | null;
  backlog: IssueWithDetails[];
  isLoading: boolean;
  fetchProjectIssues: (projectId: string, options?: { sprintId?: number }) => Promise<void>;
  fetchBacklog: (projectId: string) => Promise<void>;
  fetchSprintIssues: (sprintId: number) => Promise<void>;
  setCurrentIssue: (issue: IssueWithDetails | null) => void;
  updateIssueInList: (issue: IssueWithDetails) => void;
  removeIssueFromList: (issueId: number) => void;
}

export const useIssueStore = create<IssueState>((set, get) => ({
  issues: [],
  currentIssue: null,
  backlog: [],
  isLoading: false,

  fetchProjectIssues: async (projectId, options) => {
    set({ isLoading: true });
    try {
      const { issues } = await api.getProjectIssues(projectId, options);
      set({ issues, isLoading: false });
    } catch (error) {
      console.error('Failed to fetch issues:', error);
      set({ isLoading: false });
    }
  },

  fetchBacklog: async (projectId) => {
    set({ isLoading: true });
    try {
      const backlog = await api.getBacklogIssues(projectId);
      set({ backlog, isLoading: false });
    } catch (error) {
      console.error('Failed to fetch backlog:', error);
      set({ isLoading: false });
    }
  },

  fetchSprintIssues: async (sprintId) => {
    set({ isLoading: true });
    try {
      const issues = await api.getSprintIssues(sprintId);
      set({ issues, isLoading: false });
    } catch (error) {
      console.error('Failed to fetch sprint issues:', error);
      set({ isLoading: false });
    }
  },

  setCurrentIssue: (issue) => set({ currentIssue: issue }),

  updateIssueInList: (issue) => {
    const { issues, backlog } = get();
    set({
      issues: issues.map((i) => (i.id === issue.id ? issue : i)),
      backlog: backlog.map((i) => (i.id === issue.id ? issue : i)),
      currentIssue: get().currentIssue?.id === issue.id ? issue : get().currentIssue,
    });
  },

  removeIssueFromList: (issueId) => {
    const { issues, backlog, currentIssue } = get();
    set({
      issues: issues.filter((i) => i.id !== issueId),
      backlog: backlog.filter((i) => i.id !== issueId),
      currentIssue: currentIssue?.id === issueId ? null : currentIssue,
    });
  },
}));

interface UIState {
  sidebarOpen: boolean;
  issueModalOpen: boolean;
  createIssueModalOpen: boolean;
  searchModalOpen: boolean;
  toggleSidebar: () => void;
  setIssueModalOpen: (open: boolean) => void;
  setCreateIssueModalOpen: (open: boolean) => void;
  setSearchModalOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  issueModalOpen: false,
  createIssueModalOpen: false,
  searchModalOpen: false,

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setIssueModalOpen: (open) => set({ issueModalOpen: open }),
  setCreateIssueModalOpen: (open) => set({ createIssueModalOpen: open }),
  setSearchModalOpen: (open) => set({ searchModalOpen: open }),
}));
