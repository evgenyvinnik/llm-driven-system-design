import { createFileRoute, redirect } from '@tanstack/react-router';
import { useChannelStore } from '../../stores';

export const Route = createFileRoute('/workspace/$workspaceId/')({
  beforeLoad: async ({ params }) => {
    // Redirect to first channel if exists
    const channels = useChannelStore.getState().channels;
    if (channels.length > 0) {
      throw redirect({
        to: '/workspace/$workspaceId/channel/$channelId',
        params: { workspaceId: params.workspaceId, channelId: channels[0].id },
      });
    }
  },
  component: () => (
    <div className="flex items-center justify-center h-full text-gray-500">
      <div className="text-center">
        <h2 className="text-xl font-medium mb-2">Welcome to your workspace!</h2>
        <p>Create a channel or start a direct message to get started.</p>
      </div>
    </div>
  ),
});
