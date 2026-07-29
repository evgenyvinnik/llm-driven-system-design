import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';

function TeamPage() {
  const { orgId, teamId } = Route.useParams();
  const { channels, loadChannels } = useChatStore();
  const navigate = useNavigate();
  // The channel comes from the child route when the URL already names one.
  const { channelId } = useParams({ strict: false }) as { channelId?: string };

  useEffect(() => {
    loadChannels(teamId);
  }, [teamId, loadChannels]);

  // Same guard as the org layout: only pick a default channel when the URL
  // doesn't already name one. Unguarded, this effect fires as soon as
  // `channels` loads and rewrites the path to `channels[0]`, so deep links and
  // reloads always landed on the team's first channel no matter what was
  // requested.
  useEffect(() => {
    if (channels.length > 0 && !channelId) {
      navigate({
        to: '/org/$orgId/team/$teamId/channel/$channelId',
        params: { orgId, teamId, channelId: channels[0].id },
      });
    }
  }, [channels, orgId, teamId, channelId, navigate]);

  return <Outlet />;
}

export const Route = createFileRoute('/org/$orgId/team/$teamId')({
  component: TeamPage,
});
