import type { Project } from '../types';

interface ProjectCardProps {
  project: Project;
  onDelete: (id: string) => void;
}

/** Displays a project card with name, description, database info, and delete action. */
export function ProjectCard({ project, onDelete }: ProjectCardProps) {
  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Delete project "${project.name}"?`)) {
      onDelete(project.id);
    }
  };

  return (
    <div className="bg-supabase-surface border border-supabase-border rounded-lg p-5 hover:border-supabase-primary/50 transition-colors group">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-supabase-text">{project.name}</h3>
          {project.description && (
            <p className="text-xs text-supabase-secondary mt-1 line-clamp-2">{project.description}</p>
          )}
        </div>
        {project.memberRole === 'owner' ? (
          <button
            onClick={handleDelete}
            className="opacity-0 group-hover:opacity-100 text-supabase-secondary hover:text-supabase-danger text-sm transition-opacity"
            title="Delete project"
          >
            &times;
          </button>
        ) : (
          project.memberRole && (
            <span className="text-[10px] uppercase tracking-wider text-supabase-secondary border border-supabase-border rounded px-1.5 py-0.5">
              {project.memberRole}
            </span>
          )
        )}
      </div>
      <div className="mt-4 flex items-center gap-3 text-xs text-supabase-secondary">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 bg-supabase-primary rounded-full" />
          {project.dbName}
        </span>
        <span>{project.dbHost}:{project.dbPort}</span>
      </div>
      <div className="mt-2 text-xs text-supabase-secondary">
        {new Date(project.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}
