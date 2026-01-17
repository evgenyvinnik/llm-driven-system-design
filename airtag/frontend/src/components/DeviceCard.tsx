import { Device } from '../types';
import { useStore } from '../stores/useStore';

const deviceEmojis: Record<string, string> = {
  airtag: '&#9898;',
  iphone: '&#128241;',
  macbook: '&#128187;',
  ipad: '&#128241;',
  airpods: '&#127911;',
};

interface DeviceCardProps {
  device: Device;
  isSelected: boolean;
  lastLocation?: { latitude: number; longitude: number; timestamp: string } | null;
}

export function DeviceCard({ device, isSelected, lastLocation }: DeviceCardProps) {
  const { selectDevice, lostModeSettings } = useStore();
  const lostMode = lostModeSettings[device.id];

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };

  return (
    <div
      onClick={() => selectDevice(device)}
      className={`device-card bg-white rounded-xl p-4 cursor-pointer border-2 transition ${
        isSelected
          ? 'border-apple-blue shadow-lg'
          : 'border-transparent shadow-md hover:shadow-lg'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center space-x-3">
          <span
            className="text-3xl"
            dangerouslySetInnerHTML={{
              __html: device.emoji || deviceEmojis[device.device_type] || '&#128205;',
            }}
          />
          <div>
            <h3 className="font-semibold text-gray-800">{device.name}</h3>
            <p className="text-sm text-gray-500 capitalize">{device.device_type}</p>
          </div>
        </div>
        {lostMode?.enabled && (
          <span className="bg-apple-red text-white text-xs px-2 py-1 rounded-full">
            Lost
          </span>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-100">
        {lastLocation ? (
          <div className="flex items-center text-sm text-gray-500">
            <svg
              className="w-4 h-4 mr-1"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <span>{formatTimestamp(lastLocation.timestamp)}</span>
          </div>
        ) : (
          <div className="flex items-center text-sm text-gray-400">
            <svg
              className="w-4 h-4 mr-1"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414"
              />
            </svg>
            <span>No location found</span>
          </div>
        )}
      </div>
    </div>
  );
}
