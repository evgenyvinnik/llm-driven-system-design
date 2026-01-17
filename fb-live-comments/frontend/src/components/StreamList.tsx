import { Stream } from '../types';

interface StreamListProps {
  streams: Stream[];
  onSelect: (stream: Stream) => void;
  selectedId?: string;
}

export function StreamList({ streams, onSelect, selectedId }: StreamListProps) {
  const liveStreams = streams.filter((s) => s.status === 'live');
  const endedStreams = streams.filter((s) => s.status === 'ended');

  return (
    <div className="flex flex-col gap-4">
      {liveStreams.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
            <span className="bg-red-600 text-xs px-2 py-0.5 rounded">LIVE</span>
            Live Now
          </h2>
          <div className="grid gap-2">
            {liveStreams.map((stream) => (
              <StreamCard
                key={stream.id}
                stream={stream}
                onSelect={onSelect}
                isSelected={stream.id === selectedId}
              />
            ))}
          </div>
        </div>
      )}

      {endedStreams.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-400 mb-2">
            Past Streams
          </h2>
          <div className="grid gap-2">
            {endedStreams.map((stream) => (
              <StreamCard
                key={stream.id}
                stream={stream}
                onSelect={onSelect}
                isSelected={stream.id === selectedId}
              />
            ))}
          </div>
        </div>
      )}

      {streams.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <p className="text-lg">No streams available</p>
          <p className="text-sm mt-2">Start the backend server to see streams</p>
        </div>
      )}
    </div>
  );
}

interface StreamCardProps {
  stream: Stream;
  onSelect: (stream: Stream) => void;
  isSelected: boolean;
}

function StreamCard({ stream, onSelect, isSelected }: StreamCardProps) {
  return (
    <button
      onClick={() => onSelect(stream)}
      className={`w-full text-left p-3 rounded-lg transition-colors ${
        isSelected
          ? 'bg-blue-600 text-white'
          : 'bg-white/5 hover:bg-white/10 text-gray-200'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">{stream.title}</h3>
          {stream.description && (
            <p className="text-sm opacity-70 mt-1 line-clamp-1">
              {stream.description}
            </p>
          )}
        </div>
        <div className="text-sm opacity-70">
          {stream.viewer_count.toLocaleString()} viewers
        </div>
      </div>
    </button>
  );
}
