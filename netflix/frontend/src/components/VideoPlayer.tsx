/**
 * VideoPlayer Component
 *
 * Full-screen video player with Netflix-style controls.
 * Features: quality selection, keyboard shortcuts, progress saving,
 * fullscreen mode, and auto-hiding controls during playback.
 *
 * This component orchestrates sub-components for the player UI:
 * - TopBar: Title display and back navigation
 * - CenterPlayButton: Large central play/pause overlay
 * - ControlBar: Bottom controls (progress, volume, quality, fullscreen)
 *
 * @see useVideoPlayerControls for keyboard shortcuts and control logic
 */
import React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { usePlayerStore } from '../stores/playerStore';
import {
  TopBar,
  CenterPlayButton,
  ControlBar,
  useVideoPlayerControls,
} from './VideoPlayer/index';

/** Props for VideoPlayer component */
interface VideoPlayerProps {
  /** Video ID being played */
  videoId: string;
  /** Episode ID for series (optional) */
  episodeId?: string;
  /** Video title to display */
  title: string;
  /** Subtitle (e.g., episode title) */
  subtitle?: string;
}

/**
 * Full-screen video player component.
 * Manages playback, controls visibility, and progress tracking.
 *
 * @param props - VideoPlayer properties
 * @returns JSX element for the video player
 */
export function VideoPlayer({ videoId, episodeId, title, subtitle }: VideoPlayerProps) {
  const navigate = useNavigate();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Player store state and actions
  const {
    isPlaying,
    manifest,
    currentQuality,
    volume,
    isMuted,
    currentTime,
    duration,
    isFullscreen,
    showControls,
    isLoading,
    loadManifest,
    setQuality,
    setPlaying,
    setVolume,
    toggleMute,
    setCurrentTime,
    setDuration,
    setFullscreen,
    setShowControls,
    saveProgress,
  } = usePlayerStore();

  /**
   * Navigate back to browse page.
   * Used by both escape key and back button.
   */
  const handleNavigateBack = React.useCallback(() => {
    navigate({ to: '/browse' });
  }, [navigate]);

  // Video player controls hook
  const {
    togglePlay,
    skip,
    toggleFullscreen,
    handleMouseMove,
    handleMouseLeave,
  } = useVideoPlayerControls({
    videoRef,
    containerRef,
    volume,
    isPlaying,
    isFullscreen,
    setVolume,
    toggleMute,
    setFullscreen,
    setShowControls,
    onNavigateBack: handleNavigateBack,
  });

  // Load manifest on mount
  React.useEffect(() => {
    loadManifest(videoId, episodeId);
  }, [videoId, episodeId, loadManifest]);

  // Save progress periodically (every 10 seconds)
  React.useEffect(() => {
    const interval = setInterval(() => {
      if (isPlaying && currentTime > 0) {
        saveProgress();
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [isPlaying, currentTime, saveProgress]);

  // Save progress on unmount
  React.useEffect(() => {
    return () => {
      saveProgress();
    };
  }, [saveProgress]);

  /**
   * Updates current time in store when video time changes.
   */
  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  /**
   * Handles video metadata loaded event.
   * Sets duration and resumes from saved position if available.
   */
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);

      // Resume from saved position
      if (manifest?.resumePosition) {
        videoRef.current.currentTime = manifest.resumePosition;
      }
    }
  };

  /**
   * Handles seek requests from the progress bar.
   *
   * @param time - New playback position in seconds
   */
  const handleSeek = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    setCurrentTime(time);
  };

  /**
   * Handles volume change from the volume control.
   *
   * @param vol - New volume level (0-1)
   */
  const handleVolumeChange = (vol: number) => {
    setVolume(vol);
    if (videoRef.current) {
      videoRef.current.volume = vol;
    }
  };

  // Get stream URL - for demo, use a sample video
  const streamUrl =
    currentQuality?.url ||
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Video element */}
      <video
        ref={videoRef}
        src={streamUrl}
        className="w-full h-full"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleNavigateBack}
        onClick={togglePlay}
        playsInline
      />

      {/* Loading indicator */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="w-16 h-16 border-4 border-netflix-red border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Controls overlay */}
      <div
        className={`absolute inset-0 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Top bar with title and back button */}
        <TopBar title={title} subtitle={subtitle} onBack={handleNavigateBack} />

        {/* Center play button */}
        <CenterPlayButton isPlaying={isPlaying} onToggle={togglePlay} />

        {/* Bottom control bar */}
        <ControlBar
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          volume={volume}
          isMuted={isMuted}
          isFullscreen={isFullscreen}
          currentQuality={currentQuality}
          availableQualities={manifest?.qualities}
          onTogglePlay={togglePlay}
          onSkipBack={() => skip(-10)}
          onSkipForward={() => skip(10)}
          onSeek={handleSeek}
          onVolumeChange={handleVolumeChange}
          onMuteToggle={toggleMute}
          onToggleFullscreen={toggleFullscreen}
          onQualitySelect={setQuality}
        />
      </div>
    </div>
  );
}
