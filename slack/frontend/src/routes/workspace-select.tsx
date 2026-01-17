import { createFileRoute, redirect } from '@tanstack/react-router';
import { WorkspaceSelect } from '../components';
import { authApi, workspaceApi } from '../services/api';
import { useAuthStore, useWorkspaceStore } from '../stores';

export const Route = createFileRoute('/workspace-select')({
  beforeLoad: async () => {
    try {
      const user = await authApi.me();
      useAuthStore.getState().setUser(user);

      const workspaces = await workspaceApi.list();
      useWorkspaceStore.getState().setWorkspaces(workspaces);
    } catch (error) {
      throw redirect({ to: '/login' });
    }
  },
  component: WorkspaceSelect,
});
