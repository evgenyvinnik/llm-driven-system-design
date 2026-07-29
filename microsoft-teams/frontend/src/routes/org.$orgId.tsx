import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { ChannelList } from '../components/ChannelList';

function OrgPage() {
  const { orgId } = Route.useParams();
  const { teams, channels, loadTeams, loadChannels, currentTeamId } = useChatStore();
  const navigate = useNavigate();
  // Read the channel from the *child* route, if the URL already names one.
  const { channelId } = useParams({ strict: false }) as { channelId?: string };

  useEffect(() => {
    loadTeams(orgId);
  }, [orgId, loadTeams]);

  useEffect(() => {
    if (teams.length > 0 && !currentTeamId) {
      loadChannels(teams[0].id);
    }
  }, [teams, currentTeamId, loadChannels]);

  // Land on the team's first channel only when the URL doesn't already name
  // one. Without the `!channelId` guard this fires whenever `channels` loads
  // and rewrites the path to `channels[0]`, so deep links and page reloads
  // silently bounced to the first channel — every other channel was reachable
  // by clicking but not by URL.
  useEffect(() => {
    if (channels.length > 0 && currentTeamId && !channelId) {
      navigate({
        to: '/org/$orgId/team/$teamId/channel/$channelId',
        params: { orgId, teamId: currentTeamId, channelId: channels[0].id },
      });
    }
  }, [channels, orgId, currentTeamId, channelId, navigate]);

  return (
    <>
      <ChannelList orgId={orgId} />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute('/org/$orgId')({
  component: OrgPage,
});
