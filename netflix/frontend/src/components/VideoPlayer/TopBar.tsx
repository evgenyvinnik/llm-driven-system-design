/**
 * TopBar Component
 *
 * Displays the video title, subtitle, and back navigation button
 * at the top of the video player. Uses a gradient overlay for
 * better visibility against video content.
 */
import { ArrowLeft } from 'lucide-react';

/** Props for the TopBar component */
interface TopBarProps {
  /** Main title to display (video or movie title) */
  title: string;
  /** Optional subtitle (e.g., episode title for series) */
  subtitle?: string;
  /** Callback when back button is clicked */
  onBack: () => void;
}

/**
 * Video player top bar with title and back navigation.
 * Includes a gradient background that fades to transparent.
 *
 * @param props - TopBar properties
 * @returns JSX element for the top bar
 */
export function TopBar({ title, subtitle, onBack }: TopBarProps) {
  return (
    <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/70 to-transparent">
      <div className="flex items-center gap-4">
        <button
          onClick={onBack}
          className="text-white hover:text-netflix-light-gray"
          aria-label="Go back"
        >
          <ArrowLeft size={28} />
        </button>
        <div>
          <h1 className="text-white text-xl font-bold">{title}</h1>
          {subtitle && <p className="text-netflix-light-gray text-sm">{subtitle}</p>}
        </div>
      </div>
    </div>
  );
}
