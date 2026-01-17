import { useAppStore } from '../stores/appStore';

export function CooldownTimer() {
  const { cooldown, isAuthenticated } = useAppStore();

  if (!isAuthenticated) {
    return (
      <div className="bg-gray-800 text-gray-400 px-4 py-2 rounded-lg text-sm">
        Sign in to place pixels
      </div>
    );
  }

  if (!cooldown) {
    return null;
  }

  if (cooldown.canPlace) {
    return (
      <div className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium">
        Ready to place!
      </div>
    );
  }

  const minutes = Math.floor(cooldown.remainingSeconds / 60);
  const seconds = cooldown.remainingSeconds % 60;

  return (
    <div className="bg-gray-800 text-white px-4 py-2 rounded-lg">
      <div className="text-xs text-gray-400 mb-1">Next pixel in</div>
      <div className="text-lg font-mono font-bold">
        {minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`}
      </div>
    </div>
  );
}
