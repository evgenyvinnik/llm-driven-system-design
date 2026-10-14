import { useNavigate, useParams } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import type { Organization } from '../types';
import { OrgSelector } from './OrgSelector';

interface SidebarProps {
  organizations: Organization[];
}

/** Left sidebar with org selector, team list, user info, and logout action. */
export function Sidebar({ organizations }: SidebarProps) {
  const { user, logout } = useAuthStore();
  const { teams } = useChatStore();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { orgId?: string; teamId?: string };

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  return (
    <div className="w-16 bg-teams-sidebar flex flex-col items-center py-3 gap-2">
      {/* Org selector */}
      <OrgSelector
        organizations={organizations}
        currentOrgId={params.orgId || null}
        onSelect={(orgId) => navigate({ to: '/org/$orgId', params: { orgId } })}
      />

      <div className="w-10 border-t border-gray-600 my-1" />

      {/* Team list */}
      <div className="flex-1 overflow-y-auto flex flex-col items-center gap-1 w-full px-1">
        {teams.map((team) => (
          <button
            key={team.id}
            onClick={() =>
              params.orgId &&
              navigate({
                to: '/org/$orgId/team/$teamId',
                params: { orgId: params.orgId, teamId: team.id },
              })
            }
            aria-current={params.teamId === team.id ? 'page' : undefined}
            className={`w-12 h-12 rounded-lg flex items-center justify-center text-sm font-bold transition-colors ${
              params.teamId === team.id
                ? 'bg-teams-primary text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            title={team.name}
          >
            {team.name.charAt(0).toUpperCase()}
          </button>
        ))}
      </div>

      {/* User */}
      <div className="mt-auto flex flex-col items-center gap-2">
        <div
          className="w-10 h-10 rounded-full bg-teams-primary text-white flex items-center justify-center text-sm font-bold cursor-pointer"
          title={user?.username || 'User'}
        >
          {user?.username?.charAt(0).toUpperCase() || 'U'}
        </div>
        <button
          onClick={handleLogout}
          className="text-gray-400 hover:text-white text-xs"
          title="Sign out"
        >
          Exit
        </button>
      </div>
    </div>
  );
}
