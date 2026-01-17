interface AvatarProps {
  src?: string;
  alt: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  hasStory?: boolean;
  hasSeenStory?: boolean;
  onClick?: () => void;
}

const sizeClasses = {
  xs: 'w-6 h-6',
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-14 h-14',
  xl: 'w-20 h-20',
};

export function Avatar({
  src,
  alt,
  size = 'md',
  hasStory = false,
  hasSeenStory = false,
  onClick,
}: AvatarProps) {
  const sizeClass = sizeClasses[size];

  const content = (
    <div
      className={`${sizeClass} rounded-full bg-gray-200 overflow-hidden flex items-center justify-center ${
        onClick ? 'cursor-pointer' : ''
      }`}
      onClick={onClick}
    >
      {src ? (
        <img src={src} alt={alt} className="w-full h-full object-cover" />
      ) : (
        <span className="text-gray-500 text-sm font-medium">
          {alt.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );

  if (hasStory) {
    return (
      <div className={hasSeenStory ? 'story-ring-seen' : 'story-ring'}>
        <div className="bg-white rounded-full p-0.5">{content}</div>
      </div>
    );
  }

  return content;
}
