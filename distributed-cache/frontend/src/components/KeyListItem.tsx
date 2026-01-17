interface KeyListItemProps {
  keyName: string;
  onView: (key: string) => void;
  onDelete: (key: string) => void;
  isSelected?: boolean;
}

export function KeyListItem({
  keyName,
  onView,
  onDelete,
  isSelected,
}: KeyListItemProps) {
  return (
    <div
      className={`flex items-center justify-between p-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
        isSelected ? 'bg-blue-50' : ''
      }`}
    >
      <span className="font-mono text-sm truncate flex-1">{keyName}</span>
      <div className="flex gap-2 ml-4">
        <button
          onClick={() => onView(keyName)}
          className="px-3 py-1 text-xs bg-primary-100 text-primary-700 rounded hover:bg-primary-200 transition-colors"
        >
          View
        </button>
        <button
          onClick={() => onDelete(keyName)}
          className="px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
