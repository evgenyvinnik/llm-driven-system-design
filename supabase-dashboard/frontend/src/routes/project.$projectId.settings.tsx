import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useProjectStore, useProjectRole } from '../stores/projectStore';
import { ProjectSettings } from '../components/ProjectSettings';
import { ConnectionStatus } from '../components/ConnectionStatus';
import { ProjectMembers } from '../components/ProjectMembers';

function SettingsPage() {
  const { projectId } = Route.useParams();
  const { settings, settingsLoading, loadSettings, updateSettings } = useProjectStore();
  const { isOwner } = useProjectRole();

  useEffect(() => {
    loadSettings(projectId);
  }, [projectId, loadSettings]);

  if (settingsLoading) {
    return (
      <div className="p-6 text-supabase-secondary">Loading settings...</div>
    );
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold text-supabase-text">Project Settings</h2>
          <p className="text-sm text-supabase-secondary mt-1">
            Configure your project and database connection
          </p>
        </div>
        <ConnectionStatus projectId={projectId} />
      </div>

      {settings && (
        <ProjectSettings
          settings={settings}
          readOnly={!isOwner}
          onSave={(data) => updateSettings(projectId, data)}
        />
      )}

      <ProjectMembers projectId={projectId} />
    </div>
  );
}

export const Route = createFileRoute('/project/$projectId/settings')({
  component: SettingsPage,
});
