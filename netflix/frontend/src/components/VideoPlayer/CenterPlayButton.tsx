/**
 * CenterPlayButton Component
 *
 * Large centered play/pause button overlay for the video player.
 * Provides a prominent tap/click target for toggling playback.
 */
import { Play, Pause } from 'lucide-react';

/** Props for the CenterPlayButton component */
interface CenterPlayButtonProps {
  /** Whether the video is currently playing */
  isPlaying: boolean;
  /** Callback to toggle play/pause state */
  onToggle: () => void;
}

/**
 * Centered overlay button for play/pause control.
 * Features a semi-transparent background with hover effects.
 *
 * @param props - CenterPlayButton properties
 * @returns JSX element for the center play button
 */
export function CenterPlayButton({ isPlaying, onToggle }: CenterPlayButtonProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <button
        onClick={onToggle}
        className="w-20 h-20 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition-colors"
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <Pause size={40} className="text-white" />
        ) : (
          <Play size={40} fill="white" className="text-white ml-1" />
        )}
      </button>
    </div>
  );
}
