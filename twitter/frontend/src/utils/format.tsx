/** Formats a date into a relative time string (e.g., "5m", "2h", "3d", "Jan 15"). */
export function formatRelativeTime(date: string | Date): string {
  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);

  // A timestamp ahead of the client's clock is possible from clock skew alone,
  // and rendering the raw difference produces "-25190s" rather than degrading to
  // something sensible. Anything in the future reads as just-posted.
  if (diffInSeconds < 60) {
    return `${Math.max(diffInSeconds, 0)}s`;
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}h`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) {
    return `${diffInDays}d`;
  }

  return past.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/** Formats large numbers with K/M suffixes (e.g., 1500 becomes "1.5K"). */
export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return num.toString();
}

/** Parses hashtags in content into clickable links, returning React nodes. */
export function parseHashtags(content: string): React.ReactNode[] {
  const parts = content.split(/(#\w+)/g);
  return parts.map((part, index) => {
    if (part.startsWith('#')) {
      const hashtag = part.slice(1);
      return (
        <a
          key={index}
          href={`/hashtag/${hashtag}`}
          className="text-twitter-blue hover:underline"
        >
          {part}
        </a>
      );
    }
    return part;
  });
}

/** Parses @mentions in content into clickable profile links, returning React nodes. */
export function parseMentions(content: string): React.ReactNode[] {
  const parts = content.split(/(@\w+)/g);
  return parts.map((part, index) => {
    if (part.startsWith('@')) {
      const username = part.slice(1);
      return (
        <a
          key={index}
          href={`/${username}`}
          className="text-twitter-blue hover:underline"
        >
          {part}
        </a>
      );
    }
    return part;
  });
}

/** Parses tweet content, converting both #hashtags and @mentions into clickable links. */
export function parseContent(content: string): React.ReactNode[] {
  // First parse hashtags, then parse mentions within each part
  const hashtagParts = content.split(/(#\w+)/g);
  const result: React.ReactNode[] = [];

  hashtagParts.forEach((part, hIndex) => {
    if (part.startsWith('#')) {
      const hashtag = part.slice(1);
      result.push(
        <a
          key={`h-${hIndex}`}
          href={`/hashtag/${hashtag}`}
          className="text-twitter-blue hover:underline"
        >
          {part}
        </a>
      );
    } else {
      const mentionParts = part.split(/(@\w+)/g);
      mentionParts.forEach((mPart, mIndex) => {
        if (mPart.startsWith('@')) {
          const username = mPart.slice(1);
          result.push(
            <a
              key={`m-${hIndex}-${mIndex}`}
              href={`/${username}`}
              className="text-twitter-blue hover:underline"
            >
              {mPart}
            </a>
          );
        } else if (mPart) {
          result.push(mPart);
        }
      });
    }
  });

  return result;
}
