import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { authApi, userPluginsApi, type User, type InstalledPlugin } from '../services/api';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  installedPlugins: InstalledPlugin[];
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (username: string, email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  loadInstalledPlugins: () => Promise<void>;
  installPlugin: (pluginId: string, version?: string) => Promise<{ success: boolean; error?: string }>;
  uninstallPlugin: (pluginId: string) => Promise<{ success: boolean; error?: string }>;
  togglePlugin: (pluginId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isLoading: true,
      isAuthenticated: false,
      installedPlugins: [],

      login: async (email, password) => {
        const result = await authApi.login(email, password);
        if (result.error) {
          return { success: false, error: result.error };
        }
        if (result.data?.user) {
          set({ user: result.data.user, isAuthenticated: true });
          await get().loadInstalledPlugins();
        }
        return { success: true };
      },

      register: async (username, email, password) => {
        const result = await authApi.register(username, email, password);
        if (result.error) {
          return { success: false, error: result.error };
        }
        // Auto-login after registration
        return get().login(email, password);
      },

      logout: async () => {
        await authApi.logout();
        set({ user: null, isAuthenticated: false, installedPlugins: [] });
      },

      checkAuth: async () => {
        set({ isLoading: true });
        const result = await authApi.getMe();
        if (result.data?.user) {
          set({ user: result.data.user, isAuthenticated: true, isLoading: false });
          await get().loadInstalledPlugins();
        } else {
          set({ user: null, isAuthenticated: false, isLoading: false });
          // Still load installed plugins for anonymous users
          await get().loadInstalledPlugins();
        }
      },

      loadInstalledPlugins: async () => {
        const result = await userPluginsApi.getInstalled();
        if (result.data?.plugins) {
          set({ installedPlugins: result.data.plugins });
        }
      },

      installPlugin: async (pluginId, version) => {
        const result = await userPluginsApi.install(pluginId, version);
        if (result.error) {
          return { success: false, error: result.error };
        }
        await get().loadInstalledPlugins();
        return { success: true };
      },

      uninstallPlugin: async (pluginId) => {
        const result = await userPluginsApi.uninstall(pluginId);
        if (result.error) {
          return { success: false, error: result.error };
        }
        await get().loadInstalledPlugins();
        return { success: true };
      },

      togglePlugin: async (pluginId, enabled) => {
        const result = await userPluginsApi.toggleEnabled(pluginId, enabled);
        if (result.error) {
          return { success: false, error: result.error };
        }
        await get().loadInstalledPlugins();
        return { success: true };
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
    }
  )
);
