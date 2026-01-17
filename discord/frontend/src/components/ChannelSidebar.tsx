import { useChatStore } from '../stores/chatStore';

export function ChannelSidebar() {
  const { session, currentRoom, rooms, leaveRoom, disconnect } = useChatStore();

  const currentRoomData = rooms.find((r) => r.name === currentRoom);

  return (
    <div className="w-60 bg-discord-sidebar flex flex-col">
      {/* Server header */}
      <div className="h-12 px-4 flex items-center shadow-md border-b border-discord-dark">
        <h2 className="font-semibold text-white truncate">
          {currentRoom ? `# ${currentRoom}` : 'Baby Discord'}
        </h2>
      </div>

      {/* Channel content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
        {currentRoom ? (
          <>
            <div className="text-xs text-discord-muted uppercase font-semibold px-2 py-1">
              Current Room
            </div>
            <div className="flex items-center px-2 py-1 rounded bg-discord-selected text-discord-text">
              <span className="text-discord-muted mr-1.5">#</span>
              {currentRoom}
            </div>
            <p className="text-xs text-discord-muted px-2 mt-2">
              {currentRoomData?.memberCount || 0} members
            </p>
            <button
              onClick={leaveRoom}
              className="w-full mt-4 px-2 py-1.5 text-sm text-red-400 hover:text-red-300
                       hover:bg-discord-hover rounded transition-colors"
            >
              Leave Room
            </button>
          </>
        ) : (
          <div className="px-2 py-4 text-center">
            <p className="text-discord-muted text-sm">
              Select a room from the left sidebar or create a new one
            </p>
          </div>
        )}

        {/* Room list */}
        <div className="mt-4">
          <div className="text-xs text-discord-muted uppercase font-semibold px-2 py-1">
            All Rooms
          </div>
          {rooms.map((room) => (
            <button
              key={room.name}
              onClick={() => useChatStore.getState().joinRoom(room.name)}
              className={`w-full flex items-center px-2 py-1.5 rounded text-sm
                       transition-colors ${
                         currentRoom === room.name
                           ? 'bg-discord-selected text-white'
                           : 'text-discord-muted hover:text-discord-text hover:bg-discord-hover'
                       }`}
            >
              <span className="mr-1.5">#</span>
              {room.name}
              <span className="ml-auto text-xs text-discord-muted">
                {room.memberCount}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* User panel */}
      <div className="h-14 px-2 flex items-center bg-discord-dark">
        <div className="flex items-center flex-1 min-w-0">
          <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center mr-2">
            <span className="text-white text-sm font-semibold">
              {session?.nickname.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white font-medium truncate">
              {session?.nickname}
            </p>
            <p className="text-xs text-discord-muted truncate">Online</p>
          </div>
        </div>
        <button
          onClick={disconnect}
          className="p-2 text-discord-muted hover:text-white transition-colors"
          title="Disconnect"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
