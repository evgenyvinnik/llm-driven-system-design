/**
 * Message banner component for displaying error, success, and info messages.
 * Provides consistent styling for feedback messages across the application.
 *
 * @param props - Component props
 * @param props.type - The type of message: 'error', 'success', or 'info'
 * @param props.message - The message text to display
 * @param props.className - Optional additional CSS classes
 * @returns A styled banner element or null if no message
 */
interface MessageBannerProps {
  /** Type of message determining the color scheme */
  type: 'error' | 'success' | 'info';
  /** Message text to display */
  message: string;
  /** Optional additional CSS classes */
  className?: string;
}

/** Color mappings for different message types */
const TYPE_COLORS: Record<string, string> = {
  error: 'bg-red-50 text-red-600',
  success: 'bg-green-50 text-green-600',
  info: 'bg-blue-50 text-blue-800',
};

export function MessageBanner({ type, message, className = '' }: MessageBannerProps) {
  if (!message) {
    return null;
  }

  const colorClass = TYPE_COLORS[type];

  return (
    <div className={`${colorClass} p-3 rounded-lg text-sm ${className}`}>
      {message}
    </div>
  );
}
