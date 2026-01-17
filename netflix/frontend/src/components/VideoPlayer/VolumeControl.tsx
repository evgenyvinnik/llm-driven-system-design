/**
 * VolumeControl Component
 *
 * Volume slider with mute toggle button.
 * Shows a volume icon that changes based on current volume state.
 */
import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';

/** Props for the VolumeControl component */
interface VolumeControlProps {
  /** Current volume level (0-1) */
  volume: number;
  /** Whether audio is muted */
  isMuted: boolean;
  /** Callback when volume is changed */
  onVolumeChange: (volume: number) => void;
  /** Callback to toggle mute state */
  onMuteToggle: () => void;
}

/**
 * Volume control with slider and mute button.
 * Displays appropriate icon based on volume/mute state.
 *
 * @param props - VolumeControl properties
 * @returns JSX element for volume controls
 */
export function VolumeControl({
  volume,
  isMuted,
  onVolumeChange,
  onMuteToggle,
}: VolumeControlProps) {
  /**
   * Handles volume slider input changes.
   * Converts string value to number and calls onVolumeChange.
   */
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value);
    onVolumeChange(vol);
  };

  /** Display volume (0 if muted, otherwise current volume) */
  const displayVolume = isMuted ? 0 : volume;

  /** Whether to show the muted icon */
  const showMutedIcon = isMuted || volume === 0;

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onMuteToggle}
        className="text-white hover:text-netflix-light-gray"
        aria-label={isMuted ? 'Unmute' : 'Mute'}
      >
        {showMutedIcon ? <VolumeX size={24} /> : <Volume2 size={24} />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.1}
        value={displayVolume}
        onChange={handleVolumeChange}
        className="w-20 h-1 bg-zinc-600 rounded appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none
                  [&::-webkit-slider-thumb]:w-3
                  [&::-webkit-slider-thumb]:h-3
                  [&::-webkit-slider-thumb]:rounded-full
                  [&::-webkit-slider-thumb]:bg-white"
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={displayVolume}
      />
    </div>
  );
}
