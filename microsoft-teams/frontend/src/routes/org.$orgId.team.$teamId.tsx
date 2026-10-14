import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';

function TeamPage() {
  const { orgId, teamId } = Route.useParams();
  const channels = useChatStore((s) => s.channels);
  const channelsTeamId = useChatStore((s) => s.currentTeamId);
  const loadChannels = useChatStore((s) => s.loadChannels);
  const navigate = useNavigate();
  // The channel comes from the child route when the URL already names one.
  const { channelId } = useParams({ strict: false }) as { channelId?: string };

  useEffect(() => {
    loadChannels(teamId);
  }, [teamId, loadChannels]);

  // Pick a default channel only when the URL doesn't already name one (otherwise deep links and
  // reloads bounce to the first channel), and only from *this* team's list: right after a team
  // switch the store still holds the previous team's channels.
  useEffect(() => {
    if (!channelId && channelsTeamId === teamId && channels.length > 0) {
      navigate({
        to: '/org/$orgId/team/$teamId/channel/$channelId',
        params: { orgId, teamId, channelId: channels[0].id },
        replace: true,
      });
    }
  }, [channels, channelsTeamId, orgId, teamId, channelId, navigate]);

  return <Outlet />;
}

export const Route = createFileRoute('/org/$orgId/team/$teamId')({
  component: TeamPage,
});
