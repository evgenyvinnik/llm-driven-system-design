import { Link } from '@tanstack/react-router';
import type { TableInfo } from '../types';

interface SchemaViewerProps {
  table: TableInfo;
  projectId: string;
}

/** Displays table schema with column names, types, PK/FK indicators, and row count. */
export function SchemaViewer({ table, projectId }: SchemaViewerProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-supabase-text">{table.tableName}</h2>
          <p className="text-sm text-supabase-secondary mt-1">
            {table.columns.length} columns &middot;{' '}
            {table.rowCount != null ? `~${table.rowCount} rows` : 'row count not estimated yet (run ANALYZE)'}
          </p>
        </div>
        <Link
          to="/project/$projectId/tables/$tableName"
          params={{ projectId, tableName: table.tableName }}
          className="bg-supabase-surface border border-supabase-border hover:border-supabase-primary text-supabase-text px-4 py-2 rounded text-sm transition-colors"
        >
          View Data
        </Link>
      </div>

      <div className="bg-supabase-dark-surface border border-supabase-dark-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-supabase-dark-border">
              <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Type</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Default</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Nullable</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-supabase-secondary uppercase tracking-wider">Constraints</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((col) => (
              <tr key={col.name} className="border-b border-supabase-dark-border last:border-0 hover:bg-supabase-surface/30">
                <td className="px-4 py-3 font-mono text-supabase-text">
                  {col.name}
                </td>
                <td className="px-4 py-3 text-supabase-secondary font-mono">
                  {col.dataType}
                </td>
                <td className="px-4 py-3 text-supabase-secondary font-mono text-xs">
                  {col.columnDefault || '-'}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded ${col.isNullable ? 'bg-yellow-500/10 text-yellow-500' : 'bg-supabase-dark-border text-supabase-secondary'}`}>
                    {col.isNullable ? 'YES' : 'NO'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    {col.isPrimaryKey && (
                      <span className="text-xs px-2 py-0.5 rounded bg-supabase-primary/10 text-supabase-primary">PK</span>
                    )}
                    {col.isForeignKey && (
                      <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-400" title={col.foreignKeyRef}>
                        FK
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
