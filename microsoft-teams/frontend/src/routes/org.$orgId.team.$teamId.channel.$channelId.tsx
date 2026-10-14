import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { ChatArea } from '../components/ChatArea';
import { ThreadPanel } from '../components/ThreadPanel';
import { MemberList } from '../components/MemberList';

function ChannelPage() {
  const { channelId } = Route.useParams();
  const openChannel = useChatStore((s) => s.openChannel);
  const closeChannel = useChatStore((s) => s.closeChannel);
  const threadParentId = useChatStore((s) => s.threadParentId);
  const showMemberList = useChatStore((s) => s.showMemberList);

  // Open on mount and close on unmount or channel change. Closing always resets the store, so a
  // remount of the same channel (React StrictMode runs effects twice in development) reopens it
  // instead of being skipped as "already open" with no stream attached.
  useEffect(() => {
    void openChannel(channelId);
    return () => closeChannel();
  }, [channelId, openChannel, closeChannel]);

  return (
    <div className="flex-1 flex overflow-hidden">
      <ChatArea />
      {threadParentId && <ThreadPanel />}
      {showMemberList && <MemberList />}
    </div>
  );
}

export const Route = createFileRoute('/org/$orgId/team/$teamId/channel/$channelId')({
  component: ChannelPage,
});
