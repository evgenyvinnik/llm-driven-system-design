import type { SavedQuery } from '../types';

interface SavedQueryListProps {
  queries: SavedQuery[];
  onSelect: (query: SavedQuery) => void;
  /** Omitted for viewers, which hides the delete control. */
  onDelete?: (id: string) => void;
}

/** Displays a list of saved SQL queries with click-to-load and delete actions. */
export function SavedQueryList({ queries, onSelect, onDelete }: SavedQueryListProps) {
  if (queries.length === 0) {
    return <div className="p-4 text-xs text-supabase-secondary">No saved queries</div>;
  }

  return (
    <div className="py-1">
      {queries.map((query) => (
        <div
          key={query.id}
          className="group px-4 py-2 cursor-pointer hover:bg-supabase-surface/50 transition-colors"
          onClick={() => onSelect(query)}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm text-supabase-text truncate">{query.name}</span>
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(query.id); }}
                className="opacity-0 group-hover:opacity-100 text-supabase-secondary hover:text-supabase-danger text-xs transition-opacity"
              >
                &times;
              </button>
            )}
          </div>
          <div className="text-xs text-supabase-secondary mt-0.5 truncate font-mono">
            {query.queryText.substring(0, 60)}
          </div>
        </div>
      ))}
    </div>
  );
}
