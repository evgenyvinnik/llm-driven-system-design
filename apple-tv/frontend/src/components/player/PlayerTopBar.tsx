import { ArrowLeft } from 'lucide-react';
import type { Content } from '../../types';

/**
 * Props for the PlayerTopBar component.
 */
interface PlayerTopBarProps {
  /** Content currently being played */
  content: Content;
  /** Handler for back navigation */
  onBack: () => void;
}

/**
 * Top bar component for the video player.
 * Displays back button, content title, and episode information.
 * Appears at the top of the player overlay with gradient background.
 *
 * @param props - PlayerTopBarProps with content and back handler
 * @returns Top navigation bar with back button and title
 */
export function PlayerTopBar({ content, onBack }: PlayerTopBarProps) {
  return (
    <div className="absolute top-0 left-0 right-0 p-6 flex items-center justify-between">
      <BackButton onClick={onBack} />
      <ContentInfo content={content} />
      <Spacer />
    </div>
  );
}

/**
 * Props for the BackButton component.
 */
interface BackButtonProps {
  /** Click handler for back navigation */
  onClick: () => void;
}

/**
 * Back navigation button for the player.
 * Displays a left arrow icon with hover effect.
 *
 * @param props - BackButtonProps with click handler
 * @returns Circular back button
 */
function BackButton({ onClick }: BackButtonProps) {
  return (
    <button
      onClick={onClick}
      className="p-2 hover:bg-white/10 rounded-full transition-colors"
    >
      <ArrowLeft className="w-6 h-6" />
    </button>
  );
}

/**
 * Props for the ContentInfo component.
 */
interface ContentInfoProps {
  /** Content to display info for */
  content: Content;
}

/**
 * Content title and episode information display.
 * Shows title centered with episode details for series content.
 *
 * @param props - ContentInfoProps with content data
 * @returns Centered title with optional episode info
 */
function ContentInfo({ content }: ContentInfoProps) {
  return (
    <div className="text-center">
      <h1 className="text-lg font-semibold">{content.title}</h1>
      {content.content_type === 'episode' && (
        <p className="text-sm text-white/60">
          S{content.season_number} E{content.episode_number}
        </p>
      )}
    </div>
  );
}

/**
 * Empty spacer component to balance the top bar layout.
 * Matches the width of the back button for centered title.
 *
 * @returns Empty div with fixed width
 */
function Spacer() {
  return <div className="w-10" />;
}
