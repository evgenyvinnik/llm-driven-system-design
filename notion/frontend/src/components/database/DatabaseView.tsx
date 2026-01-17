/**
 * @fileoverview Database view container component.
 * Manages view switching, row data fetching, and renders the appropriate
 * view type (table, board, or list).
 */

import { useState, useEffect } from 'react';
import type { Page, DatabaseView as DBView, DatabaseRow, PropertySchema } from '@/types';
import { databasesApi } from '@/services/api';
import { Table, Columns, List, Calendar, Plus, ChevronDown } from 'lucide-react';
import TableView from './TableView';
import BoardView from './BoardView';
import ListView from './ListView';

/**
 * Props for the DatabaseView component.
 */
interface DatabaseViewProps {
  /** The database page containing schema information */
  database: Page;
  /** Available views for this database */
  views: DBView[];
  /** Currently selected view ID */
  activeViewId: string | null;
  /** Callback when switching views */
  onViewChange: (viewId: string) => void;
}

/** Icon mapping for each view type */
const VIEW_ICONS = {
  table: Table,
  board: Columns,
  list: List,
  calendar: Calendar,
  gallery: Columns,
};

/**
 * DatabaseView manages database visualization and CRUD operations.
 * Supports multiple view types with tabs for switching between them.
 *
 * @param props - Component props
 * @returns The rendered database view
 */
export default function DatabaseView({
  database,
  views,
  activeViewId,
  onViewChange,
}: DatabaseViewProps) {
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showViewMenu, setShowViewMenu] = useState(false);

  const activeView = views.find((v) => v.id === activeViewId) || views[0];
  const schema = database.properties_schema as PropertySchema[];

  // Fetch database rows
  useEffect(() => {
    async function fetchRows() {
      setIsLoading(true);
      try {
        const data = await databasesApi.get(database.id, activeViewId || undefined);
        setRows(data.rows);
      } catch (error) {
        console.error('Failed to fetch database rows:', error);
      } finally {
        setIsLoading(false);
      }
    }

    fetchRows();
  }, [database.id, activeViewId]);

  const handleAddRow = async () => {
    try {
      const { row } = await databasesApi.createRow(database.id);
      setRows((prev) => [...prev, row]);
    } catch (error) {
      console.error('Failed to add row:', error);
    }
  };

  const handleUpdateRow = async (rowId: string, properties: Record<string, unknown>) => {
    try {
      const { row } = await databasesApi.updateRow(database.id, rowId, properties);
      setRows((prev) => prev.map((r) => (r.id === rowId ? row : r)));
    } catch (error) {
      console.error('Failed to update row:', error);
    }
  };

  const handleDeleteRow = async (rowId: string) => {
    try {
      await databasesApi.deleteRow(database.id, rowId);
      setRows((prev) => prev.filter((r) => r.id !== rowId));
    } catch (error) {
      console.error('Failed to delete row:', error);
    }
  };

  const handleAddView = async (type: DBView['type']) => {
    try {
      const { view } = await databasesApi.createView(database.id, {
        name: `New ${type} view`,
        type,
        group_by: type === 'board' ? schema.find((p) => p.type === 'select')?.id : undefined,
      });
      onViewChange(view.id);
      setShowViewMenu(false);
    } catch (error) {
      console.error('Failed to create view:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-notion-text-secondary">Loading database...</div>
      </div>
    );
  }

  const ActiveViewIcon = VIEW_ICONS[activeView?.type || 'table'];

  return (
    <div>
      {/* View tabs */}
      <div className="flex items-center gap-2 mb-4 border-b border-notion-border pb-2">
        {views.map((view) => {
          const ViewIcon = VIEW_ICONS[view.type];
          const isActive = view.id === activeViewId;
          return (
            <button
              key={view.id}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
                isActive
                  ? 'bg-notion-hover font-medium'
                  : 'text-notion-text-secondary hover:bg-notion-hover'
              }`}
              onClick={() => onViewChange(view.id)}
            >
              <ViewIcon className="w-4 h-4" />
              {view.name}
            </button>
          );
        })}

        {/* Add view button */}
        <div className="relative">
          <button
            className="flex items-center gap-1 px-2 py-1.5 text-notion-text-secondary hover:bg-notion-hover rounded text-sm"
            onClick={() => setShowViewMenu(!showViewMenu)}
          >
            <Plus className="w-4 h-4" />
          </button>

          {showViewMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowViewMenu(false)} />
              <div className="absolute left-0 top-full z-50 bg-white border border-notion-border rounded-md shadow-lg py-1 min-w-40 mt-1">
                <div className="px-3 py-1 text-xs font-medium text-notion-text-secondary">
                  Add view
                </div>
                {(['table', 'board', 'list'] as const).map((type) => {
                  const Icon = VIEW_ICONS[type];
                  return (
                    <button
                      key={type}
                      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-notion-hover text-sm capitalize"
                      onClick={() => handleAddView(type)}
                    >
                      <Icon className="w-4 h-4" />
                      {type}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* View content */}
      {activeView?.type === 'table' && (
        <TableView
          rows={rows}
          schema={schema}
          onAddRow={handleAddRow}
          onUpdateRow={handleUpdateRow}
          onDeleteRow={handleDeleteRow}
        />
      )}

      {activeView?.type === 'board' && (
        <BoardView
          rows={rows}
          schema={schema}
          groupBy={activeView.group_by || schema.find((p) => p.type === 'select')?.id || ''}
          onAddRow={handleAddRow}
          onUpdateRow={handleUpdateRow}
          onDeleteRow={handleDeleteRow}
        />
      )}

      {activeView?.type === 'list' && (
        <ListView
          rows={rows}
          schema={schema}
          onAddRow={handleAddRow}
          onUpdateRow={handleUpdateRow}
          onDeleteRow={handleDeleteRow}
        />
      )}
    </div>
  );
}
