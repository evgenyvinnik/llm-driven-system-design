import { useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { CreateChannelModal } from './CreateChannelModal';

interface ChannelListProps {
  orgId: string;
}

/** Displays grouped channel list organized by teams with channel creation modal. */
export function ChannelList({ orgId }: ChannelListProps) {
  const { channels, teams, currentTeamId, currentChannelId, setCurrentTeam } = useChatStore();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { teamId?: string };
  const [showCreateChannel, setShowCreateChannel] = useState(false);

  const activeTeamId = params.teamId || currentTeamId;

  const handleChannelClick = (channelId: string) => {
    if (!activeTeamId) return;
    navigate({
      to: '/org/$orgId/team/$teamId/channel/$channelId',
      params: { orgId, teamId: activeTeamId, channelId },
    });
  };

  return (
    <div className="w-60 bg-teams-surface border-r border-teams-border flex flex-col">
      {/* Team selector */}
      <div className="p-3 border-b border-teams-border">
        <select
          value={activeTeamId || ''}
          onChange={(e) => setCurrentTeam(e.target.value)}
          className="w-full bg-teams-bg border border-teams-border rounded-md px-2 py-1.5 text-sm text-teams-text focus:outline-none focus:ring-1 focus:ring-teams-primary"
        >
          <option value="" disabled>
            Select a team
          </option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto py-2">
        <div className="flex items-center justify-between px-3 mb-1">
          <span className="text-xs font-semibold text-teams-secondary uppercase tracking-wider">
            Channels
          </span>
          <button
            data-testid="create-channel"
            onClick={() => setShowCreateChannel(true)}
            className="text-teams-secondary hover:text-teams-primary text-lg leading-none"
            title="Create channel"
          >
            +
          </button>
        </div>

        {channels.map((channel) => (
          <button
            key={channel.id}
            onClick={() => handleChannelClick(channel.id)}
            className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
              currentChannelId === channel.id
                ? 'bg-teams-chat text-teams-primary font-semibold'
                : 'text-teams-text hover:bg-teams-bg'
            }`}
          >
            <span className="text-teams-secondary">{channel.is_private ? '🔒' : '#'}</span>
            <span className="truncate">{channel.name}</span>
          </button>
        ))}

        {channels.length === 0 && (
          <p className="px-3 text-sm text-teams-secondary">No channels yet</p>
        )}
      </div>

      {showCreateChannel && activeTeamId && (
        <CreateChannelModal
          teamId={activeTeamId}
          onClose={() => setShowCreateChannel(false)}
        />
      )}
    </div>
  );
}
