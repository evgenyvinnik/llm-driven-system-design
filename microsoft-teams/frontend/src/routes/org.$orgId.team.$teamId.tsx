import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { teamApi } from '../services/api';
import { EmptyPane } from '../components/EmptyPane';

function TeamPage() {
  const { orgId, teamId } = Route.useParams();
  const { teams, teamsLoadedFor, channels, channelsLoadedFor, loadChannels, loadTeams } =
    useChatStore();
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  // The channel comes from the child route when the URL already names one.
  const { channelId } = useParams({ strict: false }) as { channelId?: string };
  const [joinError, setJoinError] = useState('');
  const [joining, setJoining] = useState(false);

  const team = teams.find((t) => t.id === teamId);
  const isMember = !!team?.member_role;

  // Channels are only readable by team members, so don't ask for them (and
  // don't render the channel route) until the caller has joined.
  useEffect(() => {
    if (isMember) loadChannels(teamId);
  }, [teamId, isMember, loadChannels]);

  // Only pick a default channel when the URL doesn't already name one, and
  // only from *this* team's channel list (not one still left over from the
  // previously selected team).
  useEffect(() => {
    if (channelsLoadedFor !== teamId || channelId || channels.length === 0) return;
    navigate({
      to: '/org/$orgId/team/$teamId/channel/$channelId',
      params: { orgId, teamId, channelId: channels[0].id },
      replace: true,
    });
  }, [channels, channelsLoadedFor, orgId, teamId, channelId, navigate]);

  if (teamsLoadedFor === orgId && !team) {
    return (
      <EmptyPane
        title="Team not found"
        body="It may be a private team you are not on, or you may have left it."
      />
    );
  }

  if (team && !isMember) {
    const join = async () => {
      if (!user) return;
      setJoining(true);
      setJoinError('');
      try {
        await teamApi.addMember(team.id, user.id);
        await loadTeams(orgId);
      } catch (err) {
        setJoinError(err instanceof Error ? err.message : 'Could not join the team');
      } finally {
        setJoining(false);
      }
    };
    return (
      <EmptyPane
        title={`You're not on ${team.name} yet`}
        body="Team membership is what gives you access to a team's channels. Anyone in the organization can join a public team."
      >
        <button
          data-testid="join-team"
          onClick={join}
          disabled={joining}
          className="bg-teams-primary text-white px-4 py-2 rounded-md text-sm hover:bg-teams-hover disabled:opacity-50"
        >
          {joining ? 'Joining...' : 'Join team'}
        </button>
        {joinError && <p className="text-sm text-teams-danger mt-2">{joinError}</p>}
      </EmptyPane>
    );
  }

  return <Outlet />;
}

export const Route = createFileRoute('/org/$orgId/team/$teamId')({
  component: TeamPage,
});
