/**
 * useVideoPlayerControls Hook
 *
 * Custom hook that manages video player keyboard controls and auto-hiding behavior.
 * Provides consistent keyboard shortcuts for playback control.
 */
import React from 'react';

/** Configuration options for the hook */
interface UseVideoPlayerControlsOptions {
  /** Video element reference */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Container element reference for fullscreen */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Current volume level (0-1) */
  volume: number;
  /** Whether video is currently playing */
  isPlaying: boolean;
  /** Whether in fullscreen mode */
  isFullscreen: boolean;
  /** Set volume level */
  setVolume: (volume: number) => void;
  /** Toggle mute state */
  toggleMute: () => void;
  /** Set fullscreen state */
  setFullscreen: (fullscreen: boolean) => void;
  /** Set controls visibility */
  setShowControls: (show: boolean) => void;
  /** Navigate back callback */
  onNavigateBack: () => void;
}

/** Return values from the hook */
interface UseVideoPlayerControlsReturn {
  /** Toggle play/pause state */
  togglePlay: () => void;
  /** Skip forward or backward by specified seconds */
  skip: (seconds: number) => void;
  /** Toggle fullscreen mode */
  toggleFullscreen: () => Promise<void>;
  /** Handle mouse movement (for auto-hiding controls) */
  handleMouseMove: () => void;
  /** Handle mouse leave (for auto-hiding controls) */
  handleMouseLeave: () => void;
}

/**
 * Custom hook for video player controls.
 * Handles keyboard shortcuts, fullscreen, and control visibility.
 *
 * Keyboard shortcuts:
 * - Space: Play/Pause
 * - Arrow Left: Skip back 10 seconds
 * - Arrow Right: Skip forward 10 seconds
 * - Arrow Up: Increase volume
 * - Arrow Down: Decrease volume
 * - M: Toggle mute
 * - F: Toggle fullscreen
 * - Escape: Exit fullscreen or navigate back
 *
 * @param options - Configuration options
 * @returns Control functions for the video player
 */
export function useVideoPlayerControls({
  videoRef,
  containerRef,
  volume,
  isPlaying,
  isFullscreen,
  setVolume,
  toggleMute,
  setFullscreen,
  setShowControls,
  onNavigateBack,
}: UseVideoPlayerControlsOptions): UseVideoPlayerControlsReturn {
  /** Timeout ref for auto-hiding controls */
  const controlsTimeoutRef = React.useRef<ReturnType<typeof setTimeout>>();

  /**
   * Toggles video play/pause state.
   * Uses the video element directly for immediate feedback.
   */
  const togglePlay = React.useCallback(() => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play();
      } else {
        videoRef.current.pause();
      }
    }
  }, [videoRef]);

  /**
   * Skips forward or backward by the specified number of seconds.
   *
   * @param seconds - Positive to skip forward, negative to skip back
   */
  const skip = React.useCallback(
    (seconds: number) => {
      if (videoRef.current) {
        videoRef.current.currentTime += seconds;
      }
    },
    [videoRef]
  );

  /**
   * Toggles fullscreen mode for the player container.
   * Uses the Fullscreen API.
   */
  const toggleFullscreen = React.useCallback(async () => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      await containerRef.current.requestFullscreen();
      setFullscreen(true);
    } else {
      await document.exitFullscreen();
      setFullscreen(false);
    }
  }, [containerRef, setFullscreen]);

  /**
   * Handles mouse movement over the player.
   * Shows controls and sets a timeout to hide them after 3 seconds.
   */
  const handleMouseMove = React.useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  }, [isPlaying, setShowControls]);

  /**
   * Handles mouse leaving the player area.
   * Hides controls immediately if video is playing.
   */
  const handleMouseLeave = React.useCallback(() => {
    if (isPlaying) {
      setShowControls(false);
    }
  }, [isPlaying, setShowControls]);

  // Register keyboard event handlers
  React.useEffect(() => {
    /**
     * Keyboard event handler for player controls.
     * Prevents default browser behavior for handled keys.
     */
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          skip(-10);
          break;
        case 'ArrowRight':
          skip(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume(Math.min(1, volume + 0.1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume(Math.max(0, volume - 0.1));
          break;
        case 'm':
          toggleMute();
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'Escape':
          if (isFullscreen) {
            toggleFullscreen();
          } else {
            onNavigateBack();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    volume,
    isFullscreen,
    togglePlay,
    skip,
    setVolume,
    toggleMute,
    toggleFullscreen,
    onNavigateBack,
  ]);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, []);

  return {
    togglePlay,
    skip,
    toggleFullscreen,
    handleMouseMove,
    handleMouseLeave,
  };
}
