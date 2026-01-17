import { createFileRoute, redirect } from '@tanstack/react-router';
import { authApi, workspaceApi } from '../services/api';
import { useAuthStore, useWorkspaceStore } from '../stores';

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    try {
      const user = await authApi.me();
      useAuthStore.getState().setUser(user);

      const workspaces = await workspaceApi.list();
      useWorkspaceStore.getState().setWorkspaces(workspaces);

      if (workspaces.length > 0) {
        await workspaceApi.select(workspaces[0].id);
        throw redirect({
          to: '/workspace/$workspaceId',
          params: { workspaceId: workspaces[0].id },
        });
      } else {
        throw redirect({ to: '/workspace-select' });
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Authentication')) {
        throw redirect({ to: '/login' });
      }
      throw error;
    }
  },
  component: () => null,
});
