export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

export function formatSpeed(metersPerSecond: number, type: string = 'run'): string {
  if (type === 'run' || type === 'hike' || type === 'walk') {
    // Pace: min/km
    if (metersPerSecond <= 0) return '--:--';
    const paceSecondsPerKm = 1000 / metersPerSecond;
    const paceMinutes = Math.floor(paceSecondsPerKm / 60);
    const paceSeconds = Math.floor(paceSecondsPerKm % 60);
    return `${paceMinutes}:${paceSeconds.toString().padStart(2, '0')} /km`;
  }
  // Speed: km/h for cycling
  return `${(metersPerSecond * 3.6).toFixed(1)} km/h`;
}

export function formatElevation(meters: number): string {
  return `${Math.round(meters)} m`;
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateString);
}

export function getActivityIcon(type: string): string {
  switch (type) {
    case 'run':
      return '🏃';
    case 'ride':
      return '🚴';
    case 'hike':
      return '🥾';
    case 'swim':
      return '🏊';
    case 'walk':
      return '🚶';
    default:
      return '🏃';
  }
}

export function getActivityColor(type: string): string {
  switch (type) {
    case 'run':
      return '#FC4C02';
    case 'ride':
      return '#0066CC';
    case 'hike':
      return '#228B22';
    case 'swim':
      return '#00CED1';
    case 'walk':
      return '#9370DB';
    default:
      return '#FC4C02';
  }
}
