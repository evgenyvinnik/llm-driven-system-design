import { useAppStore } from '../stores/appStore';

export function StreamInfo() {
  const currentStream = useAppStore((state) => state.currentStream);
  const viewerCount = useAppStore((state) => state.viewerCount);
  const isConnected = useAppStore((state) => state.isConnected);

  if (!currentStream) return null;

  return (
    <div className="flex items-center justify-between p-4 bg-black/30 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-white">{currentStream.title}</h1>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              isConnected ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-gray-400 text-sm">
            {isConnected ? 'Connected' : 'Reconnecting...'}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1 text-gray-300">
          <span className="text-lg">&#128065;</span>
          <span className="font-semibold">{viewerCount.toLocaleString()}</span>
          <span className="text-sm text-gray-400">watching</span>
        </div>
      </div>
    </div>
  );
}
