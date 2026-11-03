import { createFileRoute, redirect } from '@tanstack/react-router';

// /project/:id has no page of its own; land on the table editor instead of an empty pane.
export const Route = createFileRoute('/project/$projectId/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/project/$projectId/tables', params: { projectId: params.projectId } });
  },
});
