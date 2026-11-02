import { useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { teamApi } from '../services/api';
import { CreateChannelModal } from './CreateChannelModal';

interface ChannelListProps {
  orgId: string;
}

/** Team picker plus the selected team's channels, with unread badges and team actions. */
export function ChannelList({ orgId }: ChannelListProps) {
  const { channels, channelsLoadedFor, teams, currentChannelId, loadTeams } = useChatStore();
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { teamId } = useParams({ strict: false }) as { teamId?: string };
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [teamError, setTeamError] = useState('');

  const activeTeam = teams.find((t) => t.id === teamId);
  // Only show channels that belong to the team in the URL; the store may still
  // hold the previous team's list while the new one loads.
  const visibleChannels = teamId && channelsLoadedFor === teamId ? channels : [];

  // Picking a team is a navigation, not just a store update: the URL decides
  // which team and channel are open. Updating only the store swapped the
  // channel list but left the old team's channel open, and the next channel
  // click built a URL with the old team id.
  const goToTeam = (id: string) => {
    setConfirmLeave(false);
    setTeamError('');
    navigate({ to: '/org/$orgId/team/$teamId', params: { orgId, teamId: id } });
  };

  const handleChannelClick = (channelId: string) => {
    if (!teamId) return;
    navigate({
      to: '/org/$orgId/team/$teamId/channel/$channelId',
      params: { orgId, teamId, channelId },
    });
  };

  const handleCreateTeam = async () => {
    const name = prompt('Team name:');
    if (!name?.trim()) return;
    try {
      const { team, defaultChannel } = await teamApi.create(orgId, name.trim());
      await loadTeams(orgId);
      navigate({
        to: '/org/$orgId/team/$teamId/channel/$channelId',
        params: { orgId, teamId: team.id, channelId: defaultChannel.id },
      });
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : 'Could not create the team');
    }
  };

  const handleLeaveTeam = async () => {
    if (!activeTeam || !user) return;
    if (!confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    setConfirmLeave(false);
    try {
      await teamApi.removeMember(activeTeam.id, user.id);
      await loadTeams(orgId);
      navigate({ to: '/org/$orgId', params: { orgId } });
    } catch (err) {
      // e.g. 409: the last owner can't leave until someone else is an owner
      setTeamError(err instanceof Error ? err.message : 'Could not leave the team');
    }
  };

  return (
    <div className="w-60 bg-teams-surface border-r border-teams-border flex flex-col">
      {/* Team selector */}
      <div className="p-3 border-b border-teams-border space-y-2">
        <div className="flex items-center gap-1">
          <select
            value={teamId || ''}
            onChange={(e) => goToTeam(e.target.value)}
            className="flex-1 min-w-0 bg-teams-bg border border-teams-border rounded-md px-2 py-1.5 text-sm text-teams-text focus:outline-none focus:ring-1 focus:ring-teams-primary"
          >
            <option value="" disabled>
              Select a team
            </option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.is_private ? '🔒 ' : ''}
                {team.name}
                {team.member_role ? '' : ' (join)'}
              </option>
            ))}
          </select>
          <button
            data-testid="create-team"
            onClick={handleCreateTeam}
            className="px-2 py-1 text-teams-secondary hover:text-teams-primary text-lg leading-none"
            title="Create team"
          >
            +
          </button>
        </div>
        {activeTeam?.member_role && (
          <button
            data-testid="leave-team"
            onClick={handleLeaveTeam}
            onMouseLeave={() => setConfirmLeave(false)}
            className="text-xs text-teams-secondary hover:text-teams-danger"
          >
            {confirmLeave ? `Click again to leave ${activeTeam.name}` : 'Leave team'}
          </button>
        )}
        {teamError && (
          <p data-testid="team-error" className="text-xs text-teams-danger">
            {teamError}
          </p>
        )}
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto py-2">
        <div className="flex items-center justify-between px-3 mb-1">
          <span className="text-xs font-semibold text-teams-secondary uppercase tracking-wider">
            Channels
          </span>
          {activeTeam?.member_role && (
            <button
              data-testid="create-channel"
              onClick={() => setShowCreateChannel(true)}
              className="text-teams-secondary hover:text-teams-primary text-lg leading-none"
              title="Create channel"
            >
              +
            </button>
          )}
        </div>

        {visibleChannels.map((channel) => {
          const unread = currentChannelId === channel.id ? 0 : channel.unread_count ?? 0;
          return (
            <button
              key={channel.id}
              onClick={() => handleChannelClick(channel.id)}
              className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                currentChannelId === channel.id
                  ? 'bg-teams-chat text-teams-primary font-semibold'
                  : unread > 0
                    ? 'text-teams-text font-semibold hover:bg-teams-bg'
                    : 'text-teams-text hover:bg-teams-bg'
              }`}
            >
              <span className="text-teams-secondary">{channel.is_private ? '🔒' : '#'}</span>
              <span className="truncate flex-1">{channel.name}</span>
              {/* A ternary, not `unread && …`, which would render a literal 0. */}
              {unread > 0 ? (
                <span
                  data-testid="unread-badge"
                  className="ml-auto min-w-[1.25rem] px-1.5 rounded-full bg-teams-primary text-white text-xs text-center"
                >
                  {unread}
                </span>
              ) : null}
            </button>
          );
        })}

        {teamId && channelsLoadedFor === teamId && visibleChannels.length === 0 && (
          <p className="px-3 text-sm text-teams-secondary">No channels yet</p>
        )}
      </div>

      {showCreateChannel && teamId && (
        <CreateChannelModal teamId={teamId} onClose={() => setShowCreateChannel(false)} />
      )}
    </div>
  );
}
