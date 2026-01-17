/**
 * @fileoverview Kanban board view for database visualization.
 * Groups rows by a select property and displays them as cards in columns.
 */

import { useState } from 'react';
import type { DatabaseRow, PropertySchema, PropertyOption } from '@/types';
import { Plus } from 'lucide-react';
import PropertyCell from './PropertyCell';

/**
 * Props for the BoardView component.
 */
interface BoardViewProps {
  /** Database rows to display */
  rows: DatabaseRow[];
  /** Column definitions from the database schema */
  schema: PropertySchema[];
  /** Property ID to group by (must be a select type) */
  groupBy: string;
  /** Callback to add a new row */
  onAddRow: () => void;
  /** Callback to update a row's properties */
  onUpdateRow: (rowId: string, properties: Record<string, unknown>) => void;
  /** Callback to delete a row */
  onDeleteRow: (rowId: string) => void;
}

/**
 * BoardView displays database rows in a Kanban-style board.
 * Rows are grouped into columns based on a select property value.
 *
 * @param props - Component props
 * @returns The rendered board view
 */
export default function BoardView({
  rows,
  schema,
  groupBy,
  onAddRow,
  onUpdateRow,
  onDeleteRow,
}: BoardViewProps) {
  const groupByProperty = schema.find((p) => p.id === groupBy);
  const titleProperty = schema.find((p) => p.type === 'title');

  if (!groupByProperty || groupByProperty.type !== 'select') {
    return (
      <div className="text-center py-12 text-notion-text-secondary">
        <p>Board view requires a select property to group by.</p>
      </div>
    );
  }

  const options = groupByProperty.options || [];

  // Group rows by the select property value
  const groupedRows: Record<string, DatabaseRow[]> = {};

  // Initialize with all options
  options.forEach((opt) => {
    groupedRows[opt.id] = [];
  });
  groupedRows['none'] = []; // For rows without a value

  // Group rows
  rows.forEach((row) => {
    const value = row.properties[groupBy] as string;
    if (value && groupedRows[value]) {
      groupedRows[value].push(row);
    } else {
      groupedRows['none'].push(row);
    }
  });

  const handleMoveToColumn = (rowId: string, optionId: string) => {
    onUpdateRow(rowId, { [groupBy]: optionId === 'none' ? null : optionId });
  };

  const getOptionColor = (optionId: string) => {
    const option = options.find((o) => o.id === optionId);
    return option?.color || 'gray';
  };

  return (
    <div className="database-board">
      {/* No value column */}
      {groupedRows['none'].length > 0 && (
        <BoardColumn
          title="No Status"
          color="gray"
          rows={groupedRows['none']}
          titlePropertyId={titleProperty?.id || ''}
          schema={schema}
          onUpdateRow={onUpdateRow}
          onDeleteRow={onDeleteRow}
          onAddRow={onAddRow}
        />
      )}

      {/* Columns for each option */}
      {options.map((option) => (
        <BoardColumn
          key={option.id}
          title={option.name}
          color={option.color}
          rows={groupedRows[option.id]}
          titlePropertyId={titleProperty?.id || ''}
          schema={schema}
          onUpdateRow={onUpdateRow}
          onDeleteRow={onDeleteRow}
          onAddRow={() => {
            // Add row with this status pre-selected
            // For now, just add a new row
            onAddRow();
          }}
        />
      ))}
    </div>
  );
}

/**
 * Props for a single column in the board view.
 */
interface BoardColumnProps {
  /** Column title (option name) */
  title: string;
  /** Column color for styling */
  color: string;
  /** Rows belonging to this column */
  rows: DatabaseRow[];
  /** Property ID for the title field */
  titlePropertyId: string;
  /** Full schema for accessing property metadata */
  schema: PropertySchema[];
  /** Callback to update a row */
  onUpdateRow: (rowId: string, properties: Record<string, unknown>) => void;
  /** Callback to delete a row */
  onDeleteRow: (rowId: string) => void;
  /** Callback to add a row to this column */
  onAddRow: () => void;
}

/**
 * BoardColumn renders a single column in the Kanban board.
 */
function BoardColumn({
  title,
  color,
  rows,
  titlePropertyId,
  schema,
  onUpdateRow,
  onDeleteRow,
  onAddRow,
}: BoardColumnProps) {
  const colorClasses: Record<string, string> = {
    gray: 'bg-gray-100 text-gray-700',
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    yellow: 'bg-yellow-100 text-yellow-700',
    red: 'bg-red-100 text-red-700',
    purple: 'bg-purple-100 text-purple-700',
  };

  return (
    <div className="database-board-column">
      {/* Column header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <span className={`property-tag ${colorClasses[color] || colorClasses.gray}`}>
            {title}
          </span>
          <span className="text-sm text-notion-text-secondary">{rows.length}</span>
        </div>
        <button
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-border"
          onClick={onAddRow}
        >
          <Plus className="w-4 h-4 text-notion-text-secondary" />
        </button>
      </div>

      {/* Cards */}
      {rows.map((row) => (
        <BoardCard
          key={row.id}
          row={row}
          titlePropertyId={titlePropertyId}
          schema={schema}
          onUpdate={(props) => onUpdateRow(row.id, props)}
          onDelete={() => onDeleteRow(row.id)}
        />
      ))}
    </div>
  );
}

/**
 * Props for a single card in the board view.
 */
interface BoardCardProps {
  /** The database row data */
  row: DatabaseRow;
  /** Property ID for the title field */
  titlePropertyId: string;
  /** Full schema for accessing property metadata */
  schema: PropertySchema[];
  /** Callback to update the row */
  onUpdate: (properties: Record<string, unknown>) => void;
  /** Callback to delete the row */
  onDelete: () => void;
}

/**
 * BoardCard renders a single card representing a database row.
 */
function BoardCard({ row, titlePropertyId, schema, onUpdate, onDelete }: BoardCardProps) {
  const title = row.properties[titlePropertyId] as string || 'Untitled';

  // Get other visible properties (excluding title and status which is shown in column)
  const otherProperties = schema.filter(
    (p) => p.type !== 'title' && p.type !== 'select'
  );

  return (
    <div className="database-board-card group">
      <div className="font-medium mb-2">{title}</div>

      {/* Show other properties */}
      <div className="space-y-1">
        {otherProperties.slice(0, 2).map((prop) => {
          const value = row.properties[prop.id];
          if (!value) return null;

          return (
            <div key={prop.id} className="text-sm text-notion-text-secondary">
              <span className="text-xs text-notion-text-secondary">{prop.name}: </span>
              {String(value)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
