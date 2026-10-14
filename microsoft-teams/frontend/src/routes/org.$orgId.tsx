import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { ChannelList } from '../components/ChannelList';

function OrgPage() {
  const { orgId } = Route.useParams();
  const teams = useChatStore((s) => s.teams);
  const teamsOrgId = useChatStore((s) => s.currentOrgId);
  const loadTeams = useChatStore((s) => s.loadTeams);
  const navigate = useNavigate();
  // Read the team from the *child* route, if the URL already names one.
  const { teamId } = useParams({ strict: false }) as { teamId?: string };

  useEffect(() => {
    loadTeams(orgId);
  }, [orgId, loadTeams]);

  // Land on the first team only when the URL doesn't name one, and only once this org's teams
  // have loaded. Deep links and reloads keep whatever the URL says; the team route then picks a
  // channel the same way.
  useEffect(() => {
    if (!teamId && teamsOrgId === orgId && teams.length > 0) {
      navigate({
        to: '/org/$orgId/team/$teamId',
        params: { orgId, teamId: teams[0].id },
        replace: true,
      });
    }
  }, [teams, teamsOrgId, orgId, teamId, navigate]);

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
