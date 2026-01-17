/**
 * Zustand stores for global application state management.
 * Provides centralized state for authentication, projects, issues, and UI.
 * Uses Zustand for simple, hook-based state management without boilerplate.
 */

import { create } from 'zustand';
import type { User, Project, IssueWithDetails, Sprint, Workflow, Board } from '../types';
import * as api from '../services/api';

/**
 * Authentication state interface.
 * Manages the current user session and provides auth operations.
 */
interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  checkAuth: () => Promise<void>;
}

/**
 * Authentication store.
 * Manages user login state, session validation, and provides login/logout/register actions.
 * Components use this store to check auth status and display user-specific content.
 */
export const useAuthStore = create<AuthState>((set) => ({
  /** Currently authenticated user, null if not logged in */
  user: null,
  /** Whether auth check is in progress (used for initial app load) */
  isLoading: true,
  /** Whether user is authenticated */
  isAuthenticated: false,

  /**
   * Logs in a user with email and password.
   * Updates store state on success; throws on failure.
   */
  login: async (email: string, password: string) => {
    const user = await api.login(email, password);
    set({ user, isAuthenticated: true });
  },

  /**
   * Logs out the current user.
   * Clears session on server and resets store state.
   */
  logout: async () => {
    await api.logout();
    set({ user: null, isAuthenticated: false });
  },

  /**
   * Registers a new user account.
   * Automatically logs in on successful registration.
   */
  register: async (email: string, password: string, name: string) => {
    const user = await api.register(email, password, name);
    set({ user, isAuthenticated: true });
  },

  /**
   * Checks if there is an active session.
   * Called on app initialization to restore auth state from server session.
   */
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

/**
 * Project state interface.
 * Manages the list of projects and details for the currently selected project.
 */
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

/**
 * Project store.
 * Manages project list and the currently active project's full context.
 * Loads workflow, sprints, and boards when a project is selected.
 */
export const useProjectStore = create<ProjectState>((set) => ({
  /** All projects accessible to the user */
  projects: [],
  /** Currently selected project */
  currentProject: null,
  /** Workflow configuration for current project (statuses and transitions) */
  workflow: null,
  /** Sprints for current project */
  sprints: [],
  /** Boards for current project */
  boards: [],
  /** Whether project data is being loaded */
  isLoading: false,

  /**
   * Fetches all projects the user has access to.
   * Called on initial load and after project creation.
   */
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

  /**
   * Sets the current project without fetching details.
   * Used for quick project switching in the UI.
   */
  setCurrentProject: (project) => set({ currentProject: project }),

  /**
   * Fetches complete project details including workflow, sprints, and boards.
   * Called when navigating to a project's pages (board, backlog, etc.).
   * Uses Promise.all for parallel loading.
   */
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

/**
 * Issue state interface.
 * Manages issues for the current view (sprint, backlog, or search results).
 */
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

/**
 * Issue store.
 * Manages the issues displayed in the current context (board, backlog, sprint).
 * Provides optimistic updates for smooth UI when modifying issues.
 */
export const useIssueStore = create<IssueState>((set, get) => ({
  /** Issues for current view (sprint board or filtered list) */
  issues: [],
  /** Currently selected issue for detail view/modal */
  currentIssue: null,
  /** Backlog issues (not assigned to any sprint) */
  backlog: [],
  /** Whether issues are being loaded */
  isLoading: false,

  /**
   * Fetches issues for a project with optional filters.
   * Used for project-wide issue lists and filtered views.
   */
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

  /**
   * Fetches backlog issues (issues not assigned to any sprint).
   * Used in the backlog view for sprint planning.
   */
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

  /**
   * Fetches issues assigned to a specific sprint.
   * Used in sprint board and sprint planning views.
   */
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

  /**
   * Sets the current issue for the detail modal.
   * Pass null to close the issue detail view.
   */
  setCurrentIssue: (issue) => set({ currentIssue: issue }),

  /**
   * Updates an issue in all lists (issues, backlog, currentIssue).
   * Provides optimistic update after issue modifications.
   */
  updateIssueInList: (issue) => {
    const { issues, backlog } = get();
    set({
      issues: issues.map((i) => (i.id === issue.id ? issue : i)),
      backlog: backlog.map((i) => (i.id === issue.id ? issue : i)),
      currentIssue: get().currentIssue?.id === issue.id ? issue : get().currentIssue,
    });
  },

  /**
   * Removes an issue from all lists after deletion.
   * Also clears currentIssue if the deleted issue was selected.
   */
  removeIssueFromList: (issueId) => {
    const { issues, backlog, currentIssue } = get();
    set({
      issues: issues.filter((i) => i.id !== issueId),
      backlog: backlog.filter((i) => i.id !== issueId),
      currentIssue: currentIssue?.id === issueId ? null : currentIssue,
    });
  },
}));

/**
 * UI state interface.
 * Manages global UI state like sidebar visibility and modal states.
 */
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

/**
 * UI store.
 * Manages global UI state shared across components.
 * Controls visibility of sidebar and various modal dialogs.
 */
export const useUIStore = create<UIState>((set) => ({
  /** Whether the sidebar navigation is visible */
  sidebarOpen: true,
  /** Whether the issue detail modal is open */
  issueModalOpen: false,
  /** Whether the create issue modal is open */
  createIssueModalOpen: false,
  /** Whether the global search modal is open */
  searchModalOpen: false,

  /** Toggles sidebar visibility */
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  /** Opens or closes the issue detail modal */
  setIssueModalOpen: (open) => set({ issueModalOpen: open }),
  /** Opens or closes the create issue modal */
  setCreateIssueModalOpen: (open) => set({ createIssueModalOpen: open }),
  /** Opens or closes the global search modal */
  setSearchModalOpen: (open) => set({ searchModalOpen: open }),
}));
