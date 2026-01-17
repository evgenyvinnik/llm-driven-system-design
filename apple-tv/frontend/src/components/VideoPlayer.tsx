import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { usePlayerStore } from '../stores/playerStore';
import { PlayerTopBar, PlayerControls, VideoOverlay } from './player';

/**
 * Full-screen video player component with complete playback controls.
 * Provides Netflix-style viewing experience with auto-hiding controls,
 * keyboard shortcuts, quality selection, and progress persistence.
 *
 * Features:
 * - Play/pause, seek forward/backward controls
 * - Volume control with mute toggle
 * - Fullscreen toggle
 * - Quality selection for adaptive streaming
 * - Subtitle toggle (UI only in demo)
 * - Keyboard shortcuts (Space/K for play, arrows for seek/volume, M for mute, F for fullscreen)
 * - Auto-hiding controls during playback
 * - Draggable progress bar with scrubber
 * - Periodic progress saving for resume functionality
 *
 * Note: This is a demo player using simulated playback. In production,
 * this would integrate with HLS.js or a native video element for actual streaming.
 *
 * @returns Full-screen video player interface
 */
export function VideoPlayer() {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const { showControls, resetControlsTimeout } = useAutoHideControls();

  const {
    content,
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    isFullscreen,
    selectedVariant,
    togglePlay,
    seek,
    setVolume,
    toggleMute,
    setFullscreen,
    updateTime,
    selectVariant,
    saveProgress,
  } = usePlayerStore();

  // Setup keyboard controls
  useKeyboardControls({
    isPlaying,
    currentTime,
    duration,
    volume,
    isFullscreen,
    togglePlay,
    seek,
    setVolume,
    toggleMute,
    onToggleFullscreen: () => toggleFullscreen(containerRef.current, setFullscreen),
    resetControlsTimeout,
  });

  // Simulate playback progress
  usePlaybackSimulation(isPlaying, currentTime, duration, updateTime, togglePlay);

  // Auto-save progress periodically
  useProgressAutoSave(currentTime, saveProgress);

  // Save progress on unmount
  useEffect(() => {
    return () => {
      saveProgress();
    };
  }, [saveProgress]);

  /**
   * Handles back navigation with progress save.
   */
  const handleBack = useCallback(() => {
    saveProgress();
    navigate({ to: '/' });
  }, [saveProgress, navigate]);

  /**
   * Handles fullscreen toggle.
   */
  const handleToggleFullscreen = useCallback(() => {
    toggleFullscreen(containerRef.current, setFullscreen);
  }, [setFullscreen]);

  if (!content) {
    return <LoadingScreen />;
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-screen bg-black cursor-none select-none"
      onMouseMove={resetControlsTimeout}
      onMouseLeave={() => isPlaying && resetControlsTimeout()}
      style={{ cursor: showControls ? 'default' : 'none' }}
    >
      <VideoOverlay content={content} isPlaying={isPlaying} onClick={togglePlay} />

      <ControlsOverlay visible={showControls}>
        <PlayerTopBar content={content} onBack={handleBack} />
        <PlayerControls
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          volume={volume}
          isMuted={isMuted}
          isFullscreen={isFullscreen}
          variants={content.variants || []}
          selectedVariant={selectedVariant}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onSetVolume={setVolume}
          onToggleMute={toggleMute}
          onToggleFullscreen={handleToggleFullscreen}
          onSelectVariant={selectVariant}
        />
      </ControlsOverlay>
    </div>
  );
}

/**
 * Loading screen displayed while content is loading.
 *
 * @returns Centered loading message
 */
function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-black">
      <div className="text-white/60">Loading...</div>
    </div>
  );
}

/**
 * Props for the ControlsOverlay component.
 */
interface ControlsOverlayProps {
  /** Whether controls should be visible */
  visible: boolean;
  /** Child components (top bar and bottom controls) */
  children: React.ReactNode;
}

/**
 * Overlay container for player controls.
 * Provides gradient backgrounds and fade transition.
 *
 * @param props - ControlsOverlayProps with visibility and children
 * @returns Fading overlay with gradient backgrounds
 */
function ControlsOverlay({ visible, children }: ControlsOverlayProps) {
  return (
    <div
      className={`absolute inset-0 transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* Top gradient */}
      <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-black/80 to-transparent" />
      {/* Bottom gradient */}
      <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-black/80 to-transparent" />
      {children}
    </div>
  );
}

/**
 * Custom hook for auto-hiding player controls.
 * Controls visibility with 3-second timeout after activity.
 *
 * @returns Object with showControls state and reset function
 */
function useAutoHideControls() {
  const [showControls, setShowControls] = useState(true);
  const hideControlsTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isPlaying } = usePlayerStore((state) => ({ isPlaying: state.isPlaying }));

  const resetControlsTimeout = useCallback(() => {
    if (hideControlsTimeout.current) {
      clearTimeout(hideControlsTimeout.current);
    }
    setShowControls(true);
    if (isPlaying) {
      hideControlsTimeout.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isPlaying]);

  useEffect(() => {
    resetControlsTimeout();
    return () => {
      if (hideControlsTimeout.current) {
        clearTimeout(hideControlsTimeout.current);
      }
    };
  }, [resetControlsTimeout]);

  return { showControls, resetControlsTimeout };
}

/**
 * Props for the useKeyboardControls hook.
 */
interface KeyboardControlsConfig {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isFullscreen: boolean;
  togglePlay: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  onToggleFullscreen: () => void;
  resetControlsTimeout: () => void;
}

/**
 * Custom hook for keyboard shortcut handling.
 * Binds keyboard events to player controls.
 *
 * @param config - Keyboard controls configuration
 */
function useKeyboardControls(config: KeyboardControlsConfig) {
  const {
    currentTime,
    volume,
    isFullscreen,
    togglePlay,
    seek,
    setVolume,
    toggleMute,
    onToggleFullscreen,
    resetControlsTimeout,
  } = config;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          seek(currentTime - 10);
          break;
        case 'ArrowRight':
          seek(currentTime + 10);
          break;
        case 'ArrowUp':
          setVolume(Math.min(1, volume + 0.1));
          break;
        case 'ArrowDown':
          setVolume(Math.max(0, volume - 0.1));
          break;
        case 'm':
          toggleMute();
          break;
        case 'f':
          onToggleFullscreen();
          break;
        case 'Escape':
          if (isFullscreen) {
            document.exitFullscreen();
          }
          break;
      }
      resetControlsTimeout();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentTime, volume, isFullscreen, togglePlay, seek, setVolume, toggleMute, onToggleFullscreen, resetControlsTimeout]);
}

/**
 * Custom hook for simulating video playback.
 * Increments currentTime every second when playing.
 *
 * @param isPlaying - Whether video is currently playing
 * @param currentTime - Current position in seconds
 * @param duration - Total duration in seconds
 * @param updateTime - Function to update current time
 * @param togglePlay - Function to toggle play state (for end of video)
 */
function usePlaybackSimulation(
  isPlaying: boolean,
  currentTime: number,
  duration: number,
  updateTime: (time: number) => void,
  togglePlay: () => void
) {
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isPlaying) {
      interval = setInterval(() => {
        updateTime(currentTime + 1);
        if (currentTime >= duration) {
          togglePlay();
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isPlaying, currentTime, duration, updateTime, togglePlay]);
}

/**
 * Custom hook for auto-saving progress periodically.
 * Saves every 10 seconds when position is non-zero.
 *
 * @param currentTime - Current playback position
 * @param saveProgress - Function to save progress to server
 */
function useProgressAutoSave(currentTime: number, saveProgress: () => Promise<void>) {
  useEffect(() => {
    const interval = setInterval(() => {
      if (currentTime > 0) {
        saveProgress();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [currentTime, saveProgress]);
}

/**
 * Toggles fullscreen mode for the player container.
 *
 * @param container - The container element to fullscreen
 * @param setFullscreen - Function to update fullscreen state
 */
async function toggleFullscreen(
  container: HTMLDivElement | null,
  setFullscreen: (fullscreen: boolean) => void
) {
  if (!container) return;

  if (!document.fullscreenElement) {
    await container.requestFullscreen();
    setFullscreen(true);
  } else {
    await document.exitFullscreen();
    setFullscreen(false);
  }
}
