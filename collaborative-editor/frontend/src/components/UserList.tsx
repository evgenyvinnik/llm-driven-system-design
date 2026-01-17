import { useEditorStore } from '../stores/editorStore';

/**
 * UserList - Displays the list of collaborators currently editing the document.
 *
 * Shows each connected client with their:
 * - Assigned color (for presence visualization)
 * - Display name
 * - Current cursor position (if available)
 *
 * The current user is marked with "(you)" for identification.
 *
 * @returns The UserList component
 */
export function UserList() {
  const { clients, clientId, connected } = useEditorStore();

  if (!connected) {
    return (
      <div className="w-64 bg-gray-50 border-l border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-600 mb-4">Collaborators</h3>
        <p className="text-sm text-gray-400">Connecting...</p>
      </div>
    );
  }

  const clientList = Array.from(clients.values());

  return (
    <div className="w-64 bg-gray-50 border-l border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-600 mb-4">
        Collaborators ({clientList.length})
      </h3>
      <ul className="space-y-2">
        {clientList.map((client) => (
          <li
            key={client.clientId}
            className="flex items-center gap-2 p-2 rounded-lg bg-white shadow-sm"
          >
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: client.color }}
            />
            <span className="text-sm font-medium text-gray-700 truncate">
              {client.displayName}
              {client.clientId === clientId && (
                <span className="text-gray-400 font-normal"> (you)</span>
              )}
            </span>
            {client.cursor && (
              <span className="text-xs text-gray-400 ml-auto">
                pos: {client.cursor.index}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
