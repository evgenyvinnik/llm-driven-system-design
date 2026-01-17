import { useState } from 'react';

/**
 * Props for the ProgressBar component.
 */
interface ProgressBarProps {
  /** Current playback position in seconds */
  currentTime: number;
  /** Total duration of content in seconds */
  duration: number;
  /** Callback fired when user seeks to a new position */
  onSeek: (time: number) => void;
}

/**
 * Interactive progress bar component for video playback.
 * Shows current position, buffer status, and allows seeking via click/drag.
 *
 * Features:
 * - Visual progress indicator
 * - Buffer indicator (simulated)
 * - Draggable scrubber on hover
 * - Click-to-seek functionality
 *
 * @param props - ProgressBarProps with time state and seek handler
 * @returns Interactive progress bar with scrubber
 */
export function ProgressBar({ currentTime, duration, onSeek }: ProgressBarProps) {
  const [isDragging, setIsDragging] = useState(false);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  /**
   * Handles click on the progress bar to seek to clicked position.
   *
   * @param e - Mouse click event
   */
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    onSeek(pos * duration);
  };

  /**
   * Handles drag movement on the progress bar for continuous seeking.
   *
   * @param e - Mouse move event
   */
  const handleDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(pos * duration);
  };

  return (
    <div
      className="relative h-1 bg-white/30 rounded-full mb-4 cursor-pointer group"
      onClick={handleClick}
      onMouseDown={() => setIsDragging(true)}
      onMouseUp={() => setIsDragging(false)}
      onMouseLeave={() => setIsDragging(false)}
      onMouseMove={handleDrag}
    >
      {/* Buffer indicator (simulated - shows full buffer) */}
      <div className="absolute h-full w-full bg-white/20 rounded-full" />

      {/* Progress indicator */}
      <div
        className="absolute h-full bg-white rounded-full"
        style={{ width: `${progress}%` }}
      />

      {/* Scrubber handle */}
      <Scrubber progress={progress} />
    </div>
  );
}

/**
 * Props for the Scrubber component.
 */
interface ScrubberProps {
  /** Current progress percentage (0-100) */
  progress: number;
}

/**
 * Scrubber handle that appears on progress bar hover.
 * Positions itself at the current playback position.
 *
 * @param props - ScrubberProps with progress percentage
 * @returns Circular handle positioned at current progress
 */
function Scrubber({ progress }: ScrubberProps) {
  return (
    <div
      className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
      style={{ left: `calc(${progress}% - 8px)` }}
    />
  );
}
