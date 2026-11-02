import type { QueryResult } from '../types';
import { formatCell } from '../utils/format';

interface QueryResultsProps {
  result: QueryResult;
}

/** Renders SQL query results in a scrollable table with row count summary. */
export function QueryResults({ result }: QueryResultsProps) {
  if (!result.fields || result.fields.length === 0) {
    return (
      <div className="p-4">
        <div className="bg-supabase-surface border border-supabase-border rounded p-4 text-sm">
          <span className="text-supabase-primary">Success</span>
          <span className="text-supabase-secondary ml-2">
            {result.command ? `${result.command} · ` : ''}
            {result.rowCount} row{result.rowCount !== 1 ? 's' : ''} affected
          </span>
        </div>
      </div>
    );
  }

  const fieldNames = result.fields.map((f) => f.name);

  return (
    <div className="p-4">
      <div className="text-xs text-supabase-secondary mb-2 flex items-center gap-3">
        <span>
          {result.rows.length} row{result.rows.length !== 1 ? 's' : ''} returned
        </span>
        {result.truncated && (
          <span className="text-supabase-warning">
            Showing the first {result.rows.length} rows; add a LIMIT or WHERE clause to see the rest
          </span>
        )}
        {result.readOnly && <span className="text-supabase-secondary">read-only (viewer)</span>}
      </div>
      <div className="border border-supabase-dark-border rounded-lg overflow-auto max-h-[60vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0">
            <tr className="bg-supabase-dark-surface">
              {fieldNames.map((name) => (
                <th key={name} className="text-left px-4 py-2 text-xs font-medium text-supabase-secondary uppercase tracking-wider whitespace-nowrap border-b border-supabase-dark-border">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i} className="border-b border-supabase-dark-border last:border-0 hover:bg-supabase-surface/20">
                {fieldNames.map((name) => (
                  <td key={name} className="px-4 py-2 font-mono text-xs text-supabase-text whitespace-nowrap">
                    {row[name] != null ? formatCell(row[name]) : <span className="text-supabase-secondary italic">null</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
