import { useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  Subtitles,
} from 'lucide-react';
import { formatDuration } from '../../utils';
import type { EncodedVariant } from '../../types';
import { ProgressBar } from './ProgressBar';
import { QualitySettings } from './QualitySettings';

/**
 * Props for the PlayerControls component.
 */
interface PlayerControlsProps {
  /** Whether video is currently playing */
  isPlaying: boolean;
  /** Current playback position in seconds */
  currentTime: number;
  /** Total duration of content in seconds */
  duration: number;
  /** Volume level (0-1) */
  volume: number;
  /** Whether audio is muted */
  isMuted: boolean;
  /** Whether player is in fullscreen mode */
  isFullscreen: boolean;
  /** Available quality variants */
  variants: EncodedVariant[];
  /** Currently selected quality variant */
  selectedVariant: EncodedVariant | null;
  /** Toggle play/pause */
  onTogglePlay: () => void;
  /** Seek to a specific time */
  onSeek: (time: number) => void;
  /** Set volume level */
  onSetVolume: (volume: number) => void;
  /** Toggle mute state */
  onToggleMute: () => void;
  /** Toggle fullscreen mode */
  onToggleFullscreen: () => void;
  /** Select a quality variant */
  onSelectVariant: (variant: EncodedVariant) => void;
}

/**
 * Main player controls component at the bottom of the video player.
 * Contains progress bar and all playback control buttons.
 *
 * Control groups:
 * - Left: Play/pause, skip back/forward, volume, time display
 * - Right: Subtitles, settings (quality), fullscreen
 *
 * @param props - PlayerControlsProps with state and control handlers
 * @returns Bottom control bar with all player controls
 */
export function PlayerControls({
  isPlaying,
  currentTime,
  duration,
  volume,
  isMuted,
  isFullscreen,
  variants,
  selectedVariant,
  onTogglePlay,
  onSeek,
  onSetVolume,
  onToggleMute,
  onToggleFullscreen,
  onSelectVariant,
}: PlayerControlsProps) {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="absolute bottom-0 left-0 right-0 p-6">
      <ProgressBar currentTime={currentTime} duration={duration} onSeek={onSeek} />

      <div className="flex items-center justify-between">
        <LeftControls
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          volume={volume}
          isMuted={isMuted}
          onTogglePlay={onTogglePlay}
          onSeek={onSeek}
          onSetVolume={onSetVolume}
          onToggleMute={onToggleMute}
        />

        <RightControls
          isFullscreen={isFullscreen}
          showSettings={showSettings}
          variants={variants}
          selectedVariant={selectedVariant}
          onToggleSettings={() => setShowSettings(!showSettings)}
          onToggleFullscreen={onToggleFullscreen}
          onSelectVariant={onSelectVariant}
          onCloseSettings={() => setShowSettings(false)}
        />
      </div>
    </div>
  );
}

/**
 * Props for the LeftControls component.
 */
interface LeftControlsProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSetVolume: (volume: number) => void;
  onToggleMute: () => void;
}

/**
 * Left side control group for player.
 * Contains play/pause, skip buttons, volume control, and time display.
 *
 * @param props - LeftControlsProps with state and handlers
 * @returns Left-aligned control button group
 */
function LeftControls({
  isPlaying,
  currentTime,
  duration,
  volume,
  isMuted,
  onTogglePlay,
  onSeek,
  onSetVolume,
  onToggleMute,
}: LeftControlsProps) {
  return (
    <div className="flex items-center gap-4">
      <PlayPauseButton isPlaying={isPlaying} onClick={onTogglePlay} />
      <SkipButton direction="backward" onClick={() => onSeek(currentTime - 10)} />
      <SkipButton direction="forward" onClick={() => onSeek(currentTime + 10)} />
      <VolumeControl
        volume={volume}
        isMuted={isMuted}
        onToggleMute={onToggleMute}
        onSetVolume={onSetVolume}
      />
      <TimeDisplay currentTime={currentTime} duration={duration} />
    </div>
  );
}

/**
 * Props for the RightControls component.
 */
interface RightControlsProps {
  isFullscreen: boolean;
  showSettings: boolean;
  variants: EncodedVariant[];
  selectedVariant: EncodedVariant | null;
  onToggleSettings: () => void;
  onToggleFullscreen: () => void;
  onSelectVariant: (variant: EncodedVariant) => void;
  onCloseSettings: () => void;
}

/**
 * Right side control group for player.
 * Contains subtitles, settings (quality), and fullscreen buttons.
 *
 * @param props - RightControlsProps with state and handlers
 * @returns Right-aligned control button group
 */
function RightControls({
  isFullscreen,
  showSettings,
  variants,
  selectedVariant,
  onToggleSettings,
  onToggleFullscreen,
  onSelectVariant,
  onCloseSettings,
}: RightControlsProps) {
  return (
    <div className="flex items-center gap-4">
      <SubtitlesButton />
      <SettingsButton
        isOpen={showSettings}
        variants={variants}
        selectedVariant={selectedVariant}
        onToggle={onToggleSettings}
        onSelectVariant={onSelectVariant}
        onClose={onCloseSettings}
      />
      <FullscreenButton isFullscreen={isFullscreen} onClick={onToggleFullscreen} />
    </div>
  );
}

/**
 * Props for the PlayPauseButton component.
 */
interface PlayPauseButtonProps {
  /** Whether video is currently playing */
  isPlaying: boolean;
  /** Click handler */
  onClick: () => void;
}

/**
 * Play/pause toggle button.
 * Shows pause icon when playing, play icon when paused.
 *
 * @param props - PlayPauseButtonProps with state and handler
 * @returns Play or pause icon button
 */
function PlayPauseButton({ isPlaying, onClick }: PlayPauseButtonProps) {
  return (
    <button
      onClick={onClick}
      className="p-2 hover:bg-white/10 rounded-full transition-colors"
    >
      {isPlaying ? (
        <Pause className="w-8 h-8" />
      ) : (
        <Play className="w-8 h-8 fill-current" />
      )}
    </button>
  );
}

/**
 * Props for the SkipButton component.
 */
interface SkipButtonProps {
  /** Skip direction */
  direction: 'backward' | 'forward';
  /** Click handler */
  onClick: () => void;
}

/**
 * Skip forward/backward button.
 * Skips 10 seconds in the specified direction.
 *
 * @param props - SkipButtonProps with direction and handler
 * @returns Skip icon button
 */
function SkipButton({ direction, onClick }: SkipButtonProps) {
  const Icon = direction === 'backward' ? SkipBack : SkipForward;

  return (
    <button
      onClick={onClick}
      className="p-2 hover:bg-white/10 rounded-full transition-colors"
    >
      <Icon className="w-6 h-6" />
    </button>
  );
}

/**
 * Props for the VolumeControl component.
 */
interface VolumeControlProps {
  /** Current volume level (0-1) */
  volume: number;
  /** Whether audio is muted */
  isMuted: boolean;
  /** Toggle mute handler */
  onToggleMute: () => void;
  /** Volume change handler */
  onSetVolume: (volume: number) => void;
}

/**
 * Volume control with mute button and expandable slider.
 * Shows volume slider on hover for fine-grained control.
 *
 * @param props - VolumeControlProps with state and handlers
 * @returns Volume button with expandable slider
 */
function VolumeControl({
  volume,
  isMuted,
  onToggleMute,
  onSetVolume,
}: VolumeControlProps) {
  const showMutedIcon = isMuted || volume === 0;

  return (
    <div className="flex items-center gap-2 group">
      <button
        onClick={onToggleMute}
        className="p-2 hover:bg-white/10 rounded-full transition-colors"
      >
        {showMutedIcon ? (
          <VolumeX className="w-6 h-6" />
        ) : (
          <Volume2 className="w-6 h-6" />
        )}
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.1"
        value={isMuted ? 0 : volume}
        onChange={(e) => onSetVolume(parseFloat(e.target.value))}
        className="w-0 group-hover:w-24 transition-all duration-200 accent-white"
      />
    </div>
  );
}

/**
 * Props for the TimeDisplay component.
 */
interface TimeDisplayProps {
  /** Current position in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
}

/**
 * Time display showing current position and total duration.
 * Format: "1:23:45 / 2:00:00"
 *
 * @param props - TimeDisplayProps with time values
 * @returns Formatted time display text
 */
function TimeDisplay({ currentTime, duration }: TimeDisplayProps) {
  return (
    <div className="text-sm text-white/80">
      {formatDuration(currentTime)} / {formatDuration(duration)}
    </div>
  );
}

/**
 * Subtitles toggle button (UI placeholder).
 * Currently non-functional in demo mode.
 *
 * @returns Subtitles icon button
 */
function SubtitlesButton() {
  return (
    <button className="p-2 hover:bg-white/10 rounded-full transition-colors">
      <Subtitles className="w-6 h-6" />
    </button>
  );
}

/**
 * Props for the SettingsButton component.
 */
interface SettingsButtonProps {
  /** Whether settings panel is open */
  isOpen: boolean;
  /** Available quality variants */
  variants: EncodedVariant[];
  /** Currently selected variant */
  selectedVariant: EncodedVariant | null;
  /** Toggle settings panel */
  onToggle: () => void;
  /** Select variant handler */
  onSelectVariant: (variant: EncodedVariant) => void;
  /** Close panel handler */
  onClose: () => void;
}

/**
 * Settings button with quality selection dropdown.
 * Opens quality settings panel on click.
 *
 * @param props - SettingsButtonProps with state and handlers
 * @returns Settings icon button with dropdown
 */
function SettingsButton({
  isOpen,
  variants,
  selectedVariant,
  onToggle,
  onSelectVariant,
  onClose,
}: SettingsButtonProps) {
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className="p-2 hover:bg-white/10 rounded-full transition-colors"
      >
        <Settings className="w-6 h-6" />
      </button>
      <QualitySettings
        isOpen={isOpen}
        variants={variants}
        selectedVariant={selectedVariant}
        onSelectVariant={onSelectVariant}
        onClose={onClose}
      />
    </div>
  );
}

/**
 * Props for the FullscreenButton component.
 */
interface FullscreenButtonProps {
  /** Whether currently in fullscreen */
  isFullscreen: boolean;
  /** Click handler */
  onClick: () => void;
}

/**
 * Fullscreen toggle button.
 * Shows minimize icon when fullscreen, maximize when windowed.
 *
 * @param props - FullscreenButtonProps with state and handler
 * @returns Fullscreen toggle icon button
 */
function FullscreenButton({ isFullscreen, onClick }: FullscreenButtonProps) {
  return (
    <button
      onClick={onClick}
      className="p-2 hover:bg-white/10 rounded-full transition-colors"
    >
      {isFullscreen ? (
        <Minimize className="w-6 h-6" />
      ) : (
        <Maximize className="w-6 h-6" />
      )}
    </button>
  );
}
