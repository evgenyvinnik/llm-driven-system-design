/**
 * Stream List Component
 *
 * Sidebar list of available streams, separated into live and past streams.
 * Allows users to select which stream to watch.
 *
 * @module components/StreamList
 */

import { Stream } from '../types';

/** Props for the StreamList component */
interface StreamListProps {
  /** Array of all available streams */
  streams: Stream[];
  /** Callback when a stream is selected */
  onSelect: (stream: Stream) => void;
  /** ID of the currently selected stream */
  selectedId?: string;
}

/**
 * Renders the list of available streams.
 * Separates live and ended streams into sections.
 *
 * @param props - Component props with streams and selection handler
 * @returns Stream list JSX
 */
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

/** Props for the StreamCard component */
interface StreamCardProps {
  /** Stream to display */
  stream: Stream;
  /** Callback when card is clicked */
  onSelect: (stream: Stream) => void;
  /** Whether this card is currently selected */
  isSelected: boolean;
}

/**
 * Renders a single stream card in the list.
 *
 * @param props - Component props
 * @returns Stream card button JSX
 */
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
