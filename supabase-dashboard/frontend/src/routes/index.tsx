import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useProjectStore } from '../stores/projectStore';
import { ProjectCard } from '../components/ProjectCard';

function IndexPage() {
  const { user, loading: authLoading, logout } = useAuthStore();
  const { projects, projectsLoading, loadProjects, createProject, deleteProject } = useProjectStore();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: '/login' });
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      loadProjects();
    }
  }, [user, loadProjects]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreateError(null);
    try {
      const project = await createProject({ name: newName, description: newDesc || undefined });
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
      navigate({ to: '/project/$projectId/tables', params: { projectId: project.id } });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create project');
    }
  };

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-supabase-secondary">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-supabase-bg">
      {/* Header */}
      <header className="border-b border-supabase-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-supabase-primary rounded flex items-center justify-center">
            <span className="text-black font-bold text-sm">S</span>
          </div>
          <h1 className="text-lg font-semibold text-supabase-text">Supabase Dashboard</h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-supabase-secondary text-sm">{user.username}</span>
          <button
            onClick={() => logout()}
            className="text-supabase-secondary hover:text-supabase-text text-sm"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold text-supabase-text">Projects</h2>
          <button
            onClick={() => setShowCreate(true)}
            className="bg-supabase-primary hover:bg-supabase-hover text-black px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            New Project
          </button>
        </div>

        {/* Create modal */}
        {showCreate && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-supabase-surface border border-supabase-border rounded-lg p-6 w-full max-w-md">
              <h3 className="text-lg font-semibold mb-4">Create New Project</h3>
              <div className="space-y-4">
                {createError && (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded text-sm">{createError}</div>
                )}
                <div>
                  <label className="block text-sm text-supabase-secondary mb-1">Name</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
                    placeholder="My Project"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm text-supabase-secondary mb-1">Description</label>
                  <textarea
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-3 py-2 text-supabase-text text-sm focus:outline-none focus:border-supabase-primary"
                    placeholder="Optional description"
                    rows={3}
                  />
                </div>
                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => { setShowCreate(false); setNewName(''); setNewDesc(''); setCreateError(null); }}
                    className="px-4 py-2 text-sm text-supabase-secondary hover:text-supabase-text"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={!newName.trim()}
                    className="bg-supabase-primary hover:bg-supabase-hover text-black px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    Create Project
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Project list */}
        {projectsLoading ? (
          <div className="text-supabase-secondary">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-supabase-secondary mb-4">No projects yet</p>
            <button
              onClick={() => setShowCreate(true)}
              className="text-supabase-primary hover:text-supabase-hover text-sm"
            >
              Create your first project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <Link
                key={project.id}
                to="/project/$projectId/tables"
                params={{ projectId: project.id }}
                className="block"
              >
                <ProjectCard project={project} onDelete={deleteProject} />
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: IndexPage,
});
