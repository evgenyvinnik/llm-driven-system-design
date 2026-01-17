import type { Content, EncodedVariant } from '../../types';

/**
 * Props for player components that need playback state.
 */
export interface PlayerStateProps {
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
}

/**
 * Props for player control callbacks.
 */
export interface PlayerControlCallbacks {
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
}

/**
 * Props for the top bar component.
 */
export interface TopBarProps {
  /** Content being played */
  content: Content;
  /** Handler for back button */
  onBack: () => void;
}

/**
 * Props for the progress bar component.
 */
export interface ProgressBarProps {
  /** Current playback position in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Callback when position changes */
  onSeek: (time: number) => void;
}

/**
 * Props for the quality settings panel.
 */
export interface QualitySettingsProps {
  /** Whether the settings panel is visible */
  isOpen: boolean;
  /** Available quality variants */
  variants: EncodedVariant[];
  /** Currently selected variant */
  selectedVariant: EncodedVariant | null;
  /** Handler for variant selection */
  onSelectVariant: (variant: EncodedVariant) => void;
  /** Handler to close the panel */
  onClose: () => void;
}
