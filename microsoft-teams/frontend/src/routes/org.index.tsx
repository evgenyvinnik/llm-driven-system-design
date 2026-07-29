import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useChatStore } from '../stores/chatStore';

/**
 * Organization picker shown at `/org`.
 *
 * `/org` is a layout route: it renders the sidebar rail and an `<Outlet />`,
 * and the outlet is only filled once an `$orgId` is in the path. Without this
 * index route the pane beside the rail was simply blank — a dead end reachable
 * by navigating to `/org` directly or by backing out of an organization.
 */
function OrgIndexPage() {
  const organizations = useChatStore((s) => s.organizations);
  const navigate = useNavigate();

  return (
    <div className="flex-1 overflow-y-auto bg-teams-bg">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <h1 className="text-2xl font-bold text-teams-text">Your organizations</h1>
        <p className="text-sm text-teams-secondary mt-1">
          Pick an organization to see its teams and channels.
        </p>

        {organizations.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed border-gray-300 p-10 text-center">
            <p className="text-teams-text font-medium">You're not in any organizations yet</p>
            <p className="text-sm text-teams-secondary mt-1">
              An organization holds teams, and teams hold channels. Ask an admin
              for an invite to get started.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {organizations.map((org) => (
              <button
                key={org.id}
                onClick={() => navigate({ to: '/org/$orgId', params: { orgId: org.id } })}
                className="text-left bg-white rounded-lg border border-gray-200 p-5 hover:border-teams-primary hover:shadow-sm transition-all"
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-teams-primary text-white flex items-center justify-center font-bold shrink-0">
                    {org.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="font-semibold text-teams-text truncate">{org.name}</h2>
                      {org.member_role && (
                        <span className="shrink-0 inline-flex items-center rounded-full bg-teams-primary/10 px-2 py-0.5 text-xs font-medium text-teams-primary">
                          {org.member_role}
                        </span>
                      )}
                    </div>
                    {org.description && (
                      <p className="text-sm text-teams-secondary mt-1 line-clamp-2">
                        {org.description}
                      </p>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/org/')({
  component: OrgIndexPage,
});
