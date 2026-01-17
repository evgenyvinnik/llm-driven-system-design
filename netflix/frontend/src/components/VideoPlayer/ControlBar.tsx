/**
 * ControlBar Component
 *
 * Bottom controls bar for the video player containing playback controls,
 * progress bar, volume, quality selection, and fullscreen toggle.
 */
import { Play, Pause, SkipBack, SkipForward, Maximize, Minimize } from 'lucide-react';
import { ProgressBar } from './ProgressBar';
import { VolumeControl } from './VolumeControl';
import { QualitySelector } from './QualitySelector';
import type { StreamQuality } from '../../types';

/** Props for the ControlBar component */
interface ControlBarProps {
  /** Whether the video is currently playing */
  isPlaying: boolean;
  /** Current playback time in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Current volume level (0-1) */
  volume: number;
  /** Whether audio is muted */
  isMuted: boolean;
  /** Whether in fullscreen mode */
  isFullscreen: boolean;
  /** Currently selected quality level */
  currentQuality: StreamQuality | null;
  /** Available quality options */
  availableQualities: StreamQuality[] | undefined;
  /** Toggle play/pause state */
  onTogglePlay: () => void;
  /** Skip backward in seconds */
  onSkipBack: () => void;
  /** Skip forward in seconds */
  onSkipForward: () => void;
  /** Seek to a specific time */
  onSeek: (time: number) => void;
  /** Set volume level */
  onVolumeChange: (volume: number) => void;
  /** Toggle mute state */
  onMuteToggle: () => void;
  /** Toggle fullscreen mode */
  onToggleFullscreen: () => void;
  /** Select a quality level */
  onQualitySelect: (quality: StreamQuality) => void;
}

/**
 * Bottom control bar with all video playback controls.
 * Includes progress bar, play/pause, skip, volume, quality, and fullscreen.
 *
 * @param props - ControlBar properties
 * @returns JSX element for the control bar
 */
export function ControlBar({
  isPlaying,
  currentTime,
  duration,
  volume,
  isMuted,
  isFullscreen,
  currentQuality,
  availableQualities,
  onTogglePlay,
  onSkipBack,
  onSkipForward,
  onSeek,
  onVolumeChange,
  onMuteToggle,
  onToggleFullscreen,
  onQualitySelect,
}: ControlBarProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/70 to-transparent">
      {/* Progress bar */}
      <ProgressBar
        currentTime={currentTime}
        duration={duration}
        onSeek={onSeek}
      />

      {/* Control buttons */}
      <div className="flex items-center justify-between">
        {/* Left controls: play, skip, volume */}
        <div className="flex items-center gap-4">
          {/* Play/Pause */}
          <button
            onClick={onTogglePlay}
            className="text-white hover:text-netflix-light-gray"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause size={28} /> : <Play size={28} />}
          </button>

          {/* Skip back */}
          <button
            onClick={onSkipBack}
            className="text-white hover:text-netflix-light-gray"
            aria-label="Skip back 10 seconds"
          >
            <SkipBack size={24} />
          </button>

          {/* Skip forward */}
          <button
            onClick={onSkipForward}
            className="text-white hover:text-netflix-light-gray"
            aria-label="Skip forward 10 seconds"
          >
            <SkipForward size={24} />
          </button>

          {/* Volume */}
          <VolumeControl
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={onVolumeChange}
            onMuteToggle={onMuteToggle}
          />
        </div>

        {/* Right controls: quality, fullscreen */}
        <div className="flex items-center gap-4">
          {/* Quality selector */}
          <QualitySelector
            currentQuality={currentQuality}
            availableQualities={availableQualities}
            onQualitySelect={onQualitySelect}
          />

          {/* Fullscreen */}
          <button
            onClick={onToggleFullscreen}
            className="text-white hover:text-netflix-light-gray"
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? <Minimize size={24} /> : <Maximize size={24} />}
          </button>
        </div>
      </div>
    </div>
  );
}
