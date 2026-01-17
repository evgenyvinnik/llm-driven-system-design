// Format duration from seconds to HH:MM:SS or MM:SS
export const formatDuration = (seconds: number | null): string => {
  if (seconds === null || seconds === undefined) return '0:00';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

// Format view count (1.2M, 500K, etc.)
export const formatViewCount = (count: number): string => {
  if (count >= 1000000000) {
    return `${(count / 1000000000).toFixed(1)}B views`;
  }
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M views`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K views`;
  }
  return `${count} views`;
};

// Format subscriber count
export const formatSubscriberCount = (count: number): string => {
  if (count >= 1000000000) {
    return `${(count / 1000000000).toFixed(2)}B subscribers`;
  }
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(2)}M subscribers`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K subscribers`;
  }
  return `${count} subscribers`;
};

// Calculate time ago string
export const timeAgo = (dateString: string | null): string => {
  if (!dateString) return '';

  const now = new Date();
  const past = new Date(dateString);
  const diffMs = now.getTime() - past.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffYears > 0) return `${diffYears} year${diffYears > 1 ? 's' : ''} ago`;
  if (diffMonths > 0) return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
  if (diffWeeks > 0) return `${diffWeeks} week${diffWeeks > 1 ? 's' : ''} ago`;
  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffMinutes > 0) return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
  return 'Just now';
};

// Format file size
export const formatFileSize = (bytes: number): string => {
  if (bytes >= 1073741824) {
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} bytes`;
};

// Generate placeholder thumbnail URL
export const getPlaceholderThumbnail = (title: string): string => {
  // Return a simple data URI for placeholder
  return `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <rect fill="#333" width="320" height="180"/>
      <text fill="#888" font-family="sans-serif" font-size="14" x="50%" y="50%" text-anchor="middle" dy=".3em">
        ${title.substring(0, 20)}${title.length > 20 ? '...' : ''}
      </text>
    </svg>
  `)}`;
};

// Truncate text with ellipsis
export const truncate = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
};

// Generate avatar URL from username
export const getAvatarUrl = (avatarUrl: string | null, username: string): string => {
  if (avatarUrl) return avatarUrl;
  // Generate a simple avatar with first letter
  const letter = username.charAt(0).toUpperCase();
  const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF'];
  const colorIndex = username.charCodeAt(0) % colors.length;
  return `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <circle fill="${colors[colorIndex]}" cx="20" cy="20" r="20"/>
      <text fill="white" font-family="sans-serif" font-size="18" font-weight="bold" x="50%" y="50%" text-anchor="middle" dy=".35em">
        ${letter}
      </text>
    </svg>
  `)}`;
};
