/**
 * ProgressBar Component
 *
 * Video seek slider with current time and duration display.
 * Styled to match Netflix's playback controls aesthetic.
 */
import React from 'react';
import { formatTime } from './utils';

/** Props for the ProgressBar component */
interface ProgressBarProps {
  /** Current playback position in seconds */
  currentTime: number;
  /** Total video duration in seconds */
  duration: number;
  /** Callback when user seeks to a new position */
  onSeek: (time: number) => void;
}

/**
 * Progress/seek bar with time indicators.
 * Shows current position, total duration, and allows seeking.
 *
 * @param props - ProgressBar properties
 * @returns JSX element for the progress bar
 */
export function ProgressBar({ currentTime, duration, onSeek }: ProgressBarProps) {
  /**
   * Handles input range change events.
   * Converts string value to number and calls onSeek callback.
   */
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    onSeek(time);
  };

  return (
    <div className="mb-4">
      <input
        type="range"
        min={0}
        max={duration || 100}
        value={currentTime}
        onChange={handleSeek}
        className="w-full h-1 bg-zinc-600 rounded appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none
                  [&::-webkit-slider-thumb]:w-4
                  [&::-webkit-slider-thumb]:h-4
                  [&::-webkit-slider-thumb]:rounded-full
                  [&::-webkit-slider-thumb]:bg-netflix-red"
        aria-label="Seek video"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={currentTime}
      />
      <div className="flex justify-between text-xs text-netflix-light-gray mt-1">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}
