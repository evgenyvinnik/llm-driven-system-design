/**
 * Virtual waiting room component for high-demand events.
 * Displays the user's position in queue and estimated wait time.
 * Users are automatically redirected when their turn comes.
 */
import type { QueueStatus } from '../types';

/**
 * Props for the WaitingRoom component.
 */
interface WaitingRoomProps {
  /** Current queue status including position and estimated wait */
  queueStatus: QueueStatus;
  /** Callback when user chooses to leave the queue */
  onLeave: () => void;
}

/**
 * Displays waiting room UI with queue position and animated waiting indicator.
 *
 * @param props - Component props
 * @returns The rendered waiting room display
 */
export function WaitingRoom({ queueStatus, onLeave }: WaitingRoomProps) {
  const formatWaitTime = (seconds: number) => {
    if (seconds < 60) {
      return `${seconds} seconds`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
  };

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full text-center">
        <div className="mb-6">
          <div className="w-20 h-20 mx-auto bg-ticketmaster-blue rounded-full flex items-center justify-center mb-4">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-10 h-10 text-white animate-pulse"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            You're in the waiting room
          </h2>
          <p className="text-gray-600">
            High demand event - please wait for your turn
          </p>
        </div>

        <div className="bg-ticketmaster-lightBlue rounded-lg p-6 mb-6">
          <div className="text-sm text-gray-600 mb-1">Your position in queue</div>
          <div className="text-4xl font-bold text-ticketmaster-blue mb-2">
            #{queueStatus.position.toLocaleString()}
          </div>
          <div className="text-sm text-gray-600">
            Estimated wait: {formatWaitTime(queueStatus.estimated_wait_seconds)}
          </div>
        </div>

        <div className="text-sm text-gray-500 mb-6">
          <p>Please keep this page open.</p>
          <p>You'll be automatically redirected when it's your turn.</p>
        </div>

        <div className="flex items-center justify-center space-x-2 mb-6">
          <div className="w-2 h-2 bg-ticketmaster-blue rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
          <div className="w-2 h-2 bg-ticketmaster-blue rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
          <div className="w-2 h-2 bg-ticketmaster-blue rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
        </div>

        <button
          onClick={onLeave}
          className="text-sm text-gray-500 hover:text-gray-700 underline"
        >
          Leave queue
        </button>
      </div>
    </div>
  );
}
