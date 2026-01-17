import { useEditorStore } from '../stores/editorStore';

interface HeaderProps {
  title: string;
  onTitleChange?: (title: string) => void;
}

export function Header({ title, onTitleChange }: HeaderProps) {
  const { connected, serverVersion, inflightOp, pendingOps } = useEditorStore();

  const syncStatus = !connected
    ? 'Connecting...'
    : inflightOp || pendingOps.length > 0
    ? 'Syncing...'
    : 'Saved';

  const statusColor = !connected
    ? 'text-yellow-600'
    : inflightOp || pendingOps.length > 0
    ? 'text-blue-600'
    : 'text-green-600';

  return (
    <header className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold text-gray-900">
          {onTitleChange ? (
            <input
              type="text"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              className="bg-transparent border-none outline-none hover:bg-gray-100 focus:bg-gray-100 px-2 py-1 rounded"
              placeholder="Untitled Document"
            />
          ) : (
            title
          )}
        </h1>
      </div>
      <div className="flex items-center gap-4">
        <span className={`text-sm ${statusColor}`}>
          {syncStatus}
        </span>
        <span className="text-xs text-gray-400">
          v{serverVersion}
        </span>
        <div
          className={`w-2 h-2 rounded-full ${
            connected ? 'bg-green-500' : 'bg-red-500'
          }`}
          title={connected ? 'Connected' : 'Disconnected'}
        />
      </div>
    </header>
  );
}
