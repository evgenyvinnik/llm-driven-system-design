import { createFileRoute, Outlet, redirect, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { authApi, workspaceApi, channelApi, dmApi } from '../../services/api';
import { useAuthStore, useWorkspaceStore, useChannelStore, useUIStore } from '../../stores';
import { useWebSocket } from '../../hooks/useWebSocket';
import { Sidebar, ThreadPanel } from '../../components';

export const Route = createFileRoute('/workspace/$workspaceId')({
  beforeLoad: async ({ params }) => {
    try {
      // Verify auth and load user
      const user = await authApi.me();
      useAuthStore.getState().setUser(user);

      // Load workspaces
      const workspaces = await workspaceApi.list();
      useWorkspaceStore.getState().setWorkspaces(workspaces);

      // Select workspace
      await workspaceApi.select(params.workspaceId);

      const workspace = workspaces.find((w) => w.id === params.workspaceId);
      if (!workspace) {
        throw redirect({ to: '/workspace-select' });
      }

      useWorkspaceStore.getState().setCurrentWorkspace(workspace);

      // Load channels and DMs
      const [channels, dms] = await Promise.all([channelApi.list(), dmApi.list()]);
      useChannelStore.getState().setChannels(channels);
      useChannelStore.getState().setDMs(dms);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Authentication')) {
        throw redirect({ to: '/login' });
      }
      throw error;
    }
  },
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { workspaceId } = useParams({ from: '/workspace/$workspaceId' });
  const { user } = useAuthStore();
  const { currentWorkspace } = useWorkspaceStore();
  const { isThreadPanelOpen } = useUIStore();

  // Setup WebSocket connection
  useWebSocket(user?.id, workspaceId);

  return (
    <div className="flex h-screen bg-white">
      <Sidebar />
      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col">
          <Outlet />
        </div>
        {isThreadPanelOpen && <ThreadPanel />}
      </main>
    </div>
  );
}
