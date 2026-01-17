import { useTrendingStore } from '../stores/trendingStore';

interface HeaderProps {
  onSimulate: () => void;
  isSimulating: boolean;
}

export function Header({ onSimulate, isSimulating }: HeaderProps) {
  const { isConnected, lastUpdate } = useTrendingStore();

  return (
    <header className="bg-youtube-gray border-b border-gray-700 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <svg className="w-8 h-8 text-youtube-red" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z" />
          </svg>
          <h1 className="text-xl font-bold">Trending Analytics</h1>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span
              className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}
            />
            <span>{isConnected ? 'Live' : 'Disconnected'}</span>
          </div>

          {lastUpdate && (
            <span className="text-xs text-gray-500">
              Updated: {lastUpdate.toLocaleTimeString()}
            </span>
          )}

          <button
            onClick={onSimulate}
            disabled={isSimulating}
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
              isSimulating
                ? 'bg-gray-600 cursor-not-allowed'
                : 'bg-youtube-red hover:bg-red-700'
            }`}
          >
            {isSimulating ? 'Simulating...' : 'Simulate Views'}
          </button>
        </div>
      </div>
    </header>
  );
}
