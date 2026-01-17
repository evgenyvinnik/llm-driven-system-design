import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';

export function ServerList() {
  const { rooms, currentRoom, refreshRooms, joinRoom, isLoadingRooms } =
    useChatStore();

  useEffect(() => {
    refreshRooms();
    // Refresh rooms every 30 seconds
    const interval = setInterval(refreshRooms, 30000);
    return () => clearInterval(interval);
  }, [refreshRooms]);

  return (
    <div className="w-16 bg-discord-darker flex flex-col items-center py-3 gap-2">
      {/* Home button */}
      <button
        className="w-12 h-12 bg-discord-channel rounded-full flex items-center justify-center
                 hover:rounded-2xl hover:bg-indigo-600 transition-all duration-200"
        title="Home"
      >
        <svg
          className="w-6 h-6 text-white"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M12 2L2 12h3v9h6v-6h2v6h6v-9h3L12 2z" />
        </svg>
      </button>

      <div className="w-8 h-0.5 bg-discord-sidebar rounded-full my-1" />

      {/* Room list */}
      {isLoadingRooms ? (
        <div className="w-12 h-12 bg-discord-sidebar rounded-full animate-pulse" />
      ) : (
        rooms.map((room) => (
          <button
            key={room.name}
            onClick={() => joinRoom(room.name)}
            className={`w-12 h-12 rounded-full flex items-center justify-center
                     transition-all duration-200 relative group
                     ${
                       currentRoom === room.name
                         ? 'bg-indigo-600 rounded-2xl'
                         : 'bg-discord-channel hover:rounded-2xl hover:bg-indigo-600'
                     }`}
            title={room.name}
          >
            <span className="text-white font-semibold text-sm uppercase">
              {room.name.charAt(0)}
            </span>

            {/* Active indicator */}
            {currentRoom === room.name && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-white rounded-r-full" />
            )}

            {/* Tooltip */}
            <div
              className="absolute left-full ml-4 px-3 py-2 bg-discord-dark text-white text-sm
                         rounded shadow-lg opacity-0 group-hover:opacity-100 pointer-events-none
                         transition-opacity whitespace-nowrap z-50"
            >
              {room.name}
              <span className="text-discord-muted ml-1">
                ({room.memberCount} members)
              </span>
            </div>
          </button>
        ))
      )}

      {/* Add server button */}
      <button
        className="w-12 h-12 bg-discord-channel rounded-full flex items-center justify-center
                 hover:rounded-2xl hover:bg-green-600 transition-all duration-200 group"
        title="Create Room"
        onClick={() => {
          const name = prompt('Enter room name:');
          if (name) {
            useChatStore.getState().createRoom(name.toLowerCase());
          }
        }}
      >
        <svg
          className="w-6 h-6 text-green-500 group-hover:text-white transition-colors"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 4v16m8-8H4"
          />
        </svg>
      </button>
    </div>
  );
}
