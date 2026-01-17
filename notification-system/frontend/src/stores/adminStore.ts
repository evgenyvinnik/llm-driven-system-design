import { create } from 'zustand';
import { api } from '../services/api';
import type { AdminStats, Campaign, Template } from '../types';

interface AdminState {
  stats: AdminStats | null;
  users: unknown[];
  campaigns: Campaign[];
  templates: Template[];
  failedNotifications: unknown[];
  isLoading: boolean;
  error: string | null;
  fetchStats: (timeRange?: string) => Promise<void>;
  fetchUsers: (options?: { limit?: number; offset?: number; role?: string }) => Promise<void>;
  fetchCampaigns: (options?: { status?: string; limit?: number }) => Promise<void>;
  fetchTemplates: () => Promise<void>;
  fetchFailedNotifications: () => Promise<void>;
  createCampaign: (data: {
    name: string;
    description?: string;
    templateId?: string;
    channels?: string[];
    priority?: string;
  }) => Promise<Campaign>;
  startCampaign: (id: string) => Promise<{ sentCount: number }>;
  cancelCampaign: (id: string) => Promise<void>;
  createTemplate: (data: {
    id: string;
    name: string;
    description?: string;
    channels: Record<string, unknown>;
    variables?: string[];
  }) => Promise<Template>;
  deleteTemplate: (id: string) => Promise<void>;
  updateUserRole: (id: string, role: string) => Promise<void>;
  resetUserRateLimit: (id: string) => Promise<void>;
  clearError: () => void;
}

export const useAdminStore = create<AdminState>((set, get) => ({
  stats: null,
  users: [],
  campaigns: [],
  templates: [],
  failedNotifications: [],
  isLoading: false,
  error: null,

  fetchStats: async (timeRange) => {
    set({ isLoading: true, error: null });
    try {
      const stats = await api.getAdminStats(timeRange);
      set({ stats: stats as AdminStats, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch stats',
      });
    }
  },

  fetchUsers: async (options) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.getAdminUsers(options);
      set({ users: response.users, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch users',
      });
    }
  },

  fetchCampaigns: async (options) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.getCampaigns(options);
      set({ campaigns: response.campaigns as Campaign[], isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch campaigns',
      });
    }
  },

  fetchTemplates: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.getTemplates();
      set({ templates: response.templates as Template[], isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch templates',
      });
    }
  },

  fetchFailedNotifications: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.getFailedNotifications();
      set({ failedNotifications: response.notifications, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch failed notifications',
      });
    }
  },

  createCampaign: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const campaign = await api.createCampaign(data);
      set({ isLoading: false });
      get().fetchCampaigns();
      return campaign as Campaign;
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to create campaign',
      });
      throw error;
    }
  },

  startCampaign: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const result = await api.startCampaign(id);
      set({ isLoading: false });
      get().fetchCampaigns();
      return result;
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to start campaign',
      });
      throw error;
    }
  },

  cancelCampaign: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await api.cancelCampaign(id);
      set({ isLoading: false });
      get().fetchCampaigns();
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to cancel campaign',
      });
      throw error;
    }
  },

  createTemplate: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const template = await api.createTemplate(data);
      set({ isLoading: false });
      get().fetchTemplates();
      return template as Template;
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to create template',
      });
      throw error;
    }
  },

  deleteTemplate: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await api.deleteTemplate(id);
      set({ isLoading: false });
      get().fetchTemplates();
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to delete template',
      });
      throw error;
    }
  },

  updateUserRole: async (id, role) => {
    set({ isLoading: true, error: null });
    try {
      await api.updateUserRole(id, role);
      set({ isLoading: false });
      get().fetchUsers();
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to update user role',
      });
      throw error;
    }
  },

  resetUserRateLimit: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await api.resetUserRateLimit(id);
      set({ isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to reset rate limit',
      });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
