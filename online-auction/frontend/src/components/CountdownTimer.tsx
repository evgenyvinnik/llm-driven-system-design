import { useCountdown } from '../hooks/useCountdown';

interface CountdownTimerProps {
  endTime: string;
  size?: 'sm' | 'md' | 'lg';
}

export function CountdownTimer({ endTime, size = 'md' }: CountdownTimerProps) {
  const { days, hours, minutes, seconds, isExpired, totalSeconds } =
    useCountdown(endTime);

  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-lg',
    lg: 'text-2xl',
  };

  const isUrgent = totalSeconds < 300 && totalSeconds > 0;

  if (isExpired) {
    return (
      <div className={`font-bold text-gray-500 ${sizeClasses[size]}`}>
        Auction Ended
      </div>
    );
  }

  return (
    <div
      className={`font-mono font-bold ${sizeClasses[size]} ${
        isUrgent ? 'text-red-600 animate-pulse' : 'text-gray-900'
      }`}
    >
      {days > 0 && <span>{days}d </span>}
      <span>{String(hours).padStart(2, '0')}</span>:
      <span>{String(minutes).padStart(2, '0')}</span>:
      <span>{String(seconds).padStart(2, '0')}</span>
      {isUrgent && (
        <span className="ml-2 text-xs uppercase tracking-wide">Ending Soon!</span>
      )}
    </div>
  );
}
