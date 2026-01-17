import type { DatabaseRow, PropertySchema } from '@/types';
import { Plus, Trash2 } from 'lucide-react';
import PropertyCell from './PropertyCell';

interface ListViewProps {
  rows: DatabaseRow[];
  schema: PropertySchema[];
  onAddRow: () => void;
  onUpdateRow: (rowId: string, properties: Record<string, unknown>) => void;
  onDeleteRow: (rowId: string) => void;
}

export default function ListView({
  rows,
  schema,
  onAddRow,
  onUpdateRow,
  onDeleteRow,
}: ListViewProps) {
  const titleProperty = schema.find((p) => p.type === 'title');
  const otherProperties = schema.filter((p) => p.type !== 'title').slice(0, 3);

  return (
    <div>
      {rows.map((row) => {
        const title = row.properties[titleProperty?.id || ''] as string || 'Untitled';

        return (
          <div
            key={row.id}
            className="flex items-center gap-4 px-3 py-3 border-b border-notion-border hover:bg-notion-hover group"
          >
            {/* Title */}
            <div className="flex-1">
              <PropertyCell
                property={titleProperty || { id: 'title', name: 'Title', type: 'title' }}
                value={title}
                onChange={(value) => {
                  if (titleProperty) {
                    onUpdateRow(row.id, { [titleProperty.id]: value });
                  }
                }}
              />
            </div>

            {/* Other properties */}
            {otherProperties.map((prop) => (
              <div key={prop.id} className="w-32">
                <PropertyCell
                  property={prop}
                  value={row.properties[prop.id]}
                  onChange={(value) => onUpdateRow(row.id, { [prop.id]: value })}
                />
              </div>
            ))}

            {/* Delete button */}
            <button
              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-notion-border rounded"
              onClick={() => onDeleteRow(row.id)}
            >
              <Trash2 className="w-4 h-4 text-notion-text-secondary" />
            </button>
          </div>
        );
      })}

      {/* Add row button */}
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-notion-text-secondary hover:bg-notion-hover text-sm"
        onClick={onAddRow}
      >
        <Plus className="w-4 h-4" />
        New
      </button>
    </div>
  );
}
