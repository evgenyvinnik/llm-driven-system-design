import { useMemo, useState } from 'react';
import type { AppComponent } from '../../types';
import { useBindingContext } from '../../stores/dataStore';
import { resolveBindingValue, hasBindings } from '../../utils/bindings';

interface TableWidgetProps {
  component: AppComponent;
  isEditor?: boolean;
}

/** Renders a data table widget with sortable columns and row selection. */
export function TableWidget({ component }: TableWidgetProps) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  const context = useBindingContext();

  // Resolve data binding
  const rawData = useMemo(() => {
    const dataStr = component.props.data;
    if (typeof dataStr === 'string' && hasBindings(dataStr)) {
      const resolved = resolveBindingValue(dataStr, context);
      if (Array.isArray(resolved)) return resolved;
    }
    if (Array.isArray(component.props.data)) return component.props.data as Record<string, unknown>[];
    return [];
  }, [component.props.data, context]);

  const columns = useMemo(() => {
    const configCols = component.props.columns;
    if (Array.isArray(configCols) && configCols.length > 0) {
      return configCols as { key: string; label: string }[];
    }
    // Auto-detect columns from data
    if (rawData.length > 0) {
      return Object.keys(rawData[0]).map((key) => ({ key, label: key }));
    }
    return [];
  }, [component.props.columns, rawData]);

  const pageSize = typeof component.props.pageSize === 'number' ? component.props.pageSize : 10;
  const searchable = component.props.searchable !== false;

  // Filter by search
  const filteredData = useMemo(() => {
    if (!search.trim()) return rawData;
    const lower = search.toLowerCase();
    return rawData.filter((row) =>
      Object.values(row).some((v) =>
        String(v ?? '').toLowerCase().includes(lower),
      ),
    );
  }, [rawData, search]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize));
  const pageData = filteredData.slice(page * pageSize, (page + 1) * pageSize);

  if (rawData.length === 0 && columns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-retool-secondary p-4">
        <div className="text-center">
          <div className="font-medium mb-1">Table</div>
          <div className="text-xs">Bind data with {'{{ query.data }}'}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      {searchable && (
        <div className="px-3 py-2 border-b border-retool-border">
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search..."
            className="w-full px-2 py-1 text-xs border border-retool-border rounded focus:outline-none focus:ring-1 focus:ring-retool-primary"
          />
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 border-b border-retool-border sticky top-0">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-1.5 text-left font-semibold text-retool-secondary whitespace-nowrap"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.map((row, i) => (
              <tr key={i} className="border-b border-retool-border hover:bg-gray-50">
                {columns.map((col) => (
                  <td key={col.key} className="px-3 py-1.5 text-retool-text whitespace-nowrap">
                    {formatValue(row[col.key])}
                  </td>
                ))}
              </tr>
            ))}
            {pageData.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-4 text-center text-retool-secondary">
                  No data
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-retool-border bg-gray-50">
          <span className="text-xs text-retool-secondary">
            {filteredData.length} row{filteredData.length !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-2 py-0.5 text-xs border border-retool-border rounded disabled:opacity-40 hover:bg-white"
            >
              Prev
            </button>
            <span className="text-xs text-retool-secondary">
              {page + 1}/{totalPages}
            </span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-0.5 text-xs border border-retool-border rounded disabled:opacity-40 hover:bg-white"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
