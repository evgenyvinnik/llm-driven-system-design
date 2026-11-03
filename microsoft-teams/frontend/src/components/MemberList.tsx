import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { channelApi, teamApi } from '../services/api';
import type { ChannelMember, User } from '../types';
import { PresenceIndicator } from './PresenceIndicator';
import { SearchUsers } from './SearchUsers';

function MemberRow({ member, online }: { member: ChannelMember; online: boolean }) {
  const name = member.display_name || member.username;
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 hover:bg-teams-bg">
      <div className="relative">
        <div
          className={`w-7 h-7 rounded-full text-white flex items-center justify-center text-xs font-bold ${
            online ? 'bg-teams-primary' : 'bg-gray-400'
          }`}
        >
          {name.charAt(0).toUpperCase()}
        </div>
        <PresenceIndicator isOnline={online} />
      </div>
      <span className={`text-sm truncate ${online ? 'text-teams-text' : 'text-teams-secondary'}`}>
        {name}
      </span>
    </div>
  );
}

/**
 * Channel members grouped by presence, plus adding people. A public channel
 * includes the whole team, so "adding" someone there means adding them to the
 * team (owners/admins only); a private channel adds them to the channel, and
 * the server requires them to be on the team already.
 */
export function MemberList() {
  const {
    channelMembers,
    channels,
    currentChannelId,
    toggleMemberList,
    loadChannelMembers,
  } = useChatStore();
  const user = useAuthStore((s) => s.user);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const channel = channels.find((c) => c.id === currentChannelId);
  const onlineMembers = channelMembers.filter((m) => m.isOnline);
  const offlineMembers = channelMembers.filter((m) => !m.isOnline);

  const handleAdd = async (person: User) => {
    if (!channel) return;
    setNotice('');
    setError('');
    try {
      if (channel.is_private) await channelApi.addMember(channel.id, person.id);
      else await teamApi.addMember(channel.team_id, person.id);
      await loadChannelMembers(channel.id);
      setNotice(`Added ${person.display_name || person.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add member');
    }
  };

  const handleLeave = async () => {
    if (!channel || !user) return;
    setError('');
    try {
      // The server closes our stream and the store shows "no longer have access".
      await channelApi.removeMember(channel.id, user.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not leave the channel');
    }
  };

  return (
    <div className="w-60 border-l border-teams-border bg-teams-surface flex flex-col">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-teams-border">
        <h3 className="font-semibold text-sm text-teams-text">Members</h3>
        <button
          onClick={toggleMemberList}
          className="text-teams-secondary hover:text-teams-text text-lg"
          title="Close"
        >
          x
        </button>
      </div>

      {channel && (
        <div className="px-3 py-2 border-b border-teams-border space-y-1">
          <SearchUsers
            onSelect={handleAdd}
            placeholder={channel.is_private ? 'Add to channel...' : 'Add to team...'}
          />
          {notice && <p className="text-xs text-teams-success">{notice}</p>}
          {error && (
            <p data-testid="member-error" className="text-xs text-teams-danger">
              {error}
            </p>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-2">
        {onlineMembers.length > 0 && (
          <div className="mb-4">
            <div className="px-4 mb-1">
              <span className="text-xs font-semibold text-teams-secondary uppercase tracking-wider">
                Online - {onlineMembers.length}
              </span>
            </div>
            {onlineMembers.map((member) => (
              <MemberRow key={member.id} member={member} online />
            ))}
          </div>
        )}

        {offlineMembers.length > 0 && (
          <div>
            <div className="px-4 mb-1">
              <span className="text-xs font-semibold text-teams-secondary uppercase tracking-wider">
                Offline - {offlineMembers.length}
              </span>
            </div>
            {offlineMembers.map((member) => (
              <MemberRow key={member.id} member={member} online={false} />
            ))}
          </div>
        )}

        {channelMembers.length === 0 && (
          <p className="px-4 text-sm text-teams-secondary">No members</p>
        )}
      </div>

      {channel?.is_private && (
        <div className="p-3 border-t border-teams-border">
          <button
            data-testid="leave-channel"
            onClick={handleLeave}
            className="text-xs text-teams-secondary hover:text-teams-danger"
          >
            Leave channel
          </button>
        </div>
      )}
    </div>
  );
}
