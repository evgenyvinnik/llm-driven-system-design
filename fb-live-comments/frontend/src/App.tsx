import { useEffect, useState } from 'react';
import { useAppStore } from './stores/appStore';
import { useWebSocket } from './hooks/useWebSocket';
import { fetchStreams, fetchUsers } from './services/api';
import { VideoPlayer } from './components/VideoPlayer';
import { CommentList } from './components/CommentList';
import { CommentInput } from './components/CommentInput';
import { ReactionButtons } from './components/ReactionButtons';
import { FloatingReactions } from './components/FloatingReactions';
import { StreamInfo } from './components/StreamInfo';
import { StreamList } from './components/StreamList';
import { UserSelector } from './components/UserSelector';
import { User, Stream } from './types';

function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const {
    currentUser,
    setCurrentUser,
    streams,
    setStreams,
    currentStream,
    setCurrentStream,
    isConnected,
    clearComments,
  } = useAppStore();

  const { sendComment, sendReaction } = useWebSocket(
    currentStream?.id ?? null,
    currentUser?.id ?? null
  );

  // Load initial data
  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        const [streamsData, usersData] = await Promise.all([
          fetchStreams(),
          fetchUsers(),
        ]);
        setStreams(streamsData);
        setUsers(usersData);

        // Auto-select first user
        if (usersData.length > 0 && !currentUser) {
          setCurrentUser(usersData[1] || usersData[0]); // Select viewer by default
        }

        // Auto-select first live stream
        const liveStream = streamsData.find((s) => s.status === 'live');
        if (liveStream && !currentStream) {
          setCurrentStream(liveStream);
        }
      } catch (err) {
        setError('Failed to load data. Make sure the backend is running.');
        console.error(err);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, []);

  const handleSelectStream = (stream: Stream) => {
    if (stream.id !== currentStream?.id) {
      clearComments();
      setCurrentStream(stream);
    }
  };

  const handleSelectUser = (user: User) => {
    setCurrentUser(user);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center max-w-md p-6">
          <div className="text-6xl mb-4">&#9888;</div>
          <h1 className="text-2xl font-bold text-white mb-2">Connection Error</h1>
          <p className="text-gray-400 mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 flex">
      {/* Sidebar */}
      <div className="w-80 bg-black/40 border-r border-white/10 flex flex-col">
        <div className="p-4 border-b border-white/10">
          <h1 className="text-xl font-bold text-white">Live Comments</h1>
          <p className="text-sm text-gray-400 mt-1">Real-time streaming demo</p>
        </div>

        <div className="p-4 border-b border-white/10">
          <UserSelector
            users={users}
            selectedId={currentUser?.id ?? null}
            onSelect={handleSelectUser}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <StreamList
            streams={streams}
            onSelect={handleSelectStream}
            selectedId={currentStream?.id}
          />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        {currentStream ? (
          <>
            <StreamInfo />

            <div className="flex-1 flex">
              {/* Video area */}
              <div className="flex-1 p-4 relative">
                <VideoPlayer stream={currentStream} />
                <FloatingReactions />
              </div>

              {/* Comments panel */}
              <div className="w-96 bg-black/40 border-l border-white/10 flex flex-col">
                <div className="p-3 border-b border-white/10">
                  <h2 className="font-semibold text-white">Live Chat</h2>
                </div>

                <div className="flex-1 overflow-hidden">
                  <CommentList />
                </div>

                <ReactionButtons
                  onReact={sendReaction}
                  disabled={!isConnected || !currentUser}
                />

                <CommentInput
                  onSubmit={sendComment}
                  disabled={!isConnected || !currentUser}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-6xl mb-4">&#127909;</div>
              <h2 className="text-2xl font-bold text-white mb-2">
                Select a Stream
              </h2>
              <p className="text-gray-400">
                Choose a stream from the sidebar to start watching
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
