import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { ChannelList } from '../components/ChannelList';
import { EmptyPane } from '../components/EmptyPane';

function OrgPage() {
  const { orgId } = Route.useParams();
  const { teams, teamsLoadedFor, loadTeams } = useChatStore();
  const navigate = useNavigate();
  // Read the team from the *child* route, if the URL already names one.
  const { teamId } = useParams({ strict: false }) as { teamId?: string };

  useEffect(() => {
    loadTeams(orgId);
  }, [orgId, loadTeams]);

  // Land on a team only when the URL doesn't already name one, and only once
  // *this* org's teams have arrived. The team route then picks the channel.
  // This used to jump straight to a channel using `currentTeamId`, which still
  // held the previous org's team after switching orgs, so it navigated to
  // /org/<new>/team/<old>/... — a team from another organization.
  useEffect(() => {
    if (teamsLoadedFor !== orgId || teamId) return;
    const first = teams.find((t) => t.member_role) ?? teams[0];
    if (first) {
      navigate({
        to: '/org/$orgId/team/$teamId',
        params: { orgId, teamId: first.id },
        replace: true,
      });
    }
  }, [teams, teamsLoadedFor, orgId, teamId, navigate]);

  return (
    <>
      <ChannelList orgId={orgId} />
      {teamId ? (
        <Outlet />
      ) : teamsLoadedFor === orgId && teams.length === 0 ? (
        <EmptyPane
          title="No teams yet"
          body="An organization holds teams, and teams hold channels. Create a team from the menu on the left to start a conversation."
        />
      ) : null}
    </>
  );
}

export const Route = createFileRoute('/org/$orgId')({
  component: OrgPage,
});
