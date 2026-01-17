import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/projects/$projectKey/')({
  component: ProjectIndexPage,
});

function ProjectIndexPage() {
  const { projectKey } = Route.useParams();
  // Redirect to board by default
  return <Navigate to={`/projects/${projectKey}/board`} />;
}
