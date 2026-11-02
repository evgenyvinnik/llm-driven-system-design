import type { TableInfo } from '../types';

interface TableListProps {
  tables: TableInfo[];
  loading: boolean;
  selectedTable: string | null;
  onSelect: (name: string) => void;
  /** Omitted for viewers, which hides the drop control. */
  onDrop?: (name: string) => void;
}

/** Displays a sidebar list of database tables with selection highlighting and drop action. */
export function TableList({ tables, loading, selectedTable, onSelect, onDrop }: TableListProps) {
  if (loading) {
    return <div className="p-4 text-sm text-supabase-secondary">Loading tables...</div>;
  }

  if (tables.length === 0) {
    return <div className="p-4 text-sm text-supabase-secondary">No tables found</div>;
  }

  return (
    <div className="py-1">
      {tables.map((table) => (
        <div
          key={table.tableName}
          className={`group flex items-center justify-between px-4 py-2 cursor-pointer text-sm transition-colors ${
            selectedTable === table.tableName
              ? 'bg-supabase-surface text-supabase-text'
              : 'text-supabase-secondary hover:text-supabase-text hover:bg-supabase-surface/50'
          }`}
          onClick={() => onSelect(table.tableName)}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono text-supabase-secondary">T</span>
            <span className="truncate">{table.tableName}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-supabase-secondary">{table.columns.length} cols</span>
            {onDrop && (
              <button
                onClick={(e) => { e.stopPropagation(); onDrop(table.tableName); }}
                className="opacity-0 group-hover:opacity-100 text-supabase-secondary hover:text-supabase-danger text-xs transition-opacity"
                title="Drop table"
              >
                &times;
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
