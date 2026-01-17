import { createFileRoute, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { channelApi } from '../../../services/api';
import { useChannelStore } from '../../../stores';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { useAuthStore, useWorkspaceStore } from '../../../stores';
import { MessageList } from '../../../components';

export const Route = createFileRoute('/workspace/$workspaceId/channel/$channelId')({
  component: ChannelView,
});

function ChannelView() {
  const { workspaceId, channelId } = useParams({
    from: '/workspace/$workspaceId/channel/$channelId',
  });
  const { user } = useAuthStore();
  const { channels, dms, setCurrentChannel } = useChannelStore();
  const { sendTyping } = useWebSocket(user?.id, workspaceId);

  useEffect(() => {
    const channel = channels.find((c) => c.id === channelId) || dms.find((d) => d.id === channelId);
    if (channel) {
      setCurrentChannel(channel);
      // Mark as read
      channelApi.markRead(channelId).catch(console.error);
    }

    return () => {
      setCurrentChannel(null);
    };
  }, [channelId, channels, dms, setCurrentChannel]);

  const handleTyping = () => {
    sendTyping(channelId);
  };

  return <MessageList channelId={channelId} sendTyping={handleTyping} />;
}
