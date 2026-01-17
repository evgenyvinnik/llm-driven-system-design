import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
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
  ArrowLeft,
  Subtitles
} from 'lucide-react';
import { usePlayerStore } from '../stores/playerStore';
import { formatDuration, getResolutionLabel } from '../utils';

export function VideoPlayer() {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const hideControlsTimeout = useRef<ReturnType<typeof setTimeout>>(null);

  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

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

  // Auto-hide controls
  const resetControlsTimeout = useCallback(() => {
    if (hideControlsTimeout.current) {
      clearTimeout(hideControlsTimeout.current);
    }
    setShowControls(true);
    if (isPlaying && !showSettings) {
      hideControlsTimeout.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isPlaying, showSettings]);

  useEffect(() => {
    resetControlsTimeout();
    return () => {
      if (hideControlsTimeout.current) {
        clearTimeout(hideControlsTimeout.current);
      }
    };
  }, [resetControlsTimeout]);

  // Keyboard controls
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
          toggleFullscreen();
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
  }, [currentTime, volume, isFullscreen, togglePlay, seek, setVolume, toggleMute, resetControlsTimeout]);

  // Simulate playback progress
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

  // Save progress periodically
  useEffect(() => {
    const interval = setInterval(() => {
      if (currentTime > 0) {
        saveProgress();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [currentTime, saveProgress]);

  // Save progress on unmount
  useEffect(() => {
    return () => {
      saveProgress();
    };
  }, [saveProgress]);

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      await containerRef.current.requestFullscreen();
      setFullscreen(true);
    } else {
      await document.exitFullscreen();
      setFullscreen(false);
    }
  };

  const handleProgressClick = (e: React.MouseEvent) => {
    if (!progressRef.current) return;
    const rect = progressRef.current.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    seek(pos * duration);
  };

  const handleProgressDrag = (e: React.MouseEvent) => {
    if (!isDragging || !progressRef.current) return;
    const rect = progressRef.current.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(pos * duration);
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  if (!content) {
    return (
      <div className="flex items-center justify-center h-screen bg-black">
        <div className="text-white/60">Loading...</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-screen bg-black cursor-none select-none"
      onMouseMove={resetControlsTimeout}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      style={{ cursor: showControls ? 'default' : 'none' }}
    >
      {/* Video placeholder (in production, this would be an actual video element) */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        onClick={togglePlay}
      >
        <img
          src={content.banner_url || content.thumbnail_url}
          alt={content.title}
          className="w-full h-full object-cover opacity-50"
        />
        {!isPlaying && (
          <div className="absolute inset-0 flex items-center justify-center">
            <button className="p-6 bg-white/20 rounded-full backdrop-blur">
              <Play className="w-16 h-16 text-white fill-current" />
            </button>
          </div>
        )}
      </div>

      {/* Controls overlay */}
      <div
        className={`absolute inset-0 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Top gradient */}
        <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-black/80 to-transparent" />

        {/* Bottom gradient */}
        <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-black/80 to-transparent" />

        {/* Top bar */}
        <div className="absolute top-0 left-0 right-0 p-6 flex items-center justify-between">
          <button
            onClick={() => {
              saveProgress();
              navigate({ to: '/' });
            }}
            className="p-2 hover:bg-white/10 rounded-full transition-colors"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>

          <div className="text-center">
            <h1 className="text-lg font-semibold">{content.title}</h1>
            {content.content_type === 'episode' && (
              <p className="text-sm text-white/60">
                S{content.season_number} E{content.episode_number}
              </p>
            )}
          </div>

          <div className="w-10" /> {/* Spacer */}
        </div>

        {/* Bottom controls */}
        <div className="absolute bottom-0 left-0 right-0 p-6">
          {/* Progress bar */}
          <div
            ref={progressRef}
            className="relative h-1 bg-white/30 rounded-full mb-4 cursor-pointer group"
            onClick={handleProgressClick}
            onMouseDown={() => setIsDragging(true)}
            onMouseUp={() => setIsDragging(false)}
            onMouseLeave={() => setIsDragging(false)}
            onMouseMove={handleProgressDrag}
          >
            {/* Buffer indicator */}
            <div className="absolute h-full w-full bg-white/20 rounded-full" />

            {/* Progress */}
            <div
              className="absolute h-full bg-white rounded-full"
              style={{ width: `${progress}%` }}
            />

            {/* Scrubber */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ left: `calc(${progress}% - 8px)` }}
            />
          </div>

          {/* Control buttons */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Play/Pause */}
              <button
                onClick={togglePlay}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                {isPlaying ? (
                  <Pause className="w-8 h-8" />
                ) : (
                  <Play className="w-8 h-8 fill-current" />
                )}
              </button>

              {/* Skip backward */}
              <button
                onClick={() => seek(currentTime - 10)}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                <SkipBack className="w-6 h-6" />
              </button>

              {/* Skip forward */}
              <button
                onClick={() => seek(currentTime + 10)}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                <SkipForward className="w-6 h-6" />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2 group">
                <button
                  onClick={toggleMute}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                  {isMuted || volume === 0 ? (
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
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-0 group-hover:w-24 transition-all duration-200 accent-white"
                />
              </div>

              {/* Time */}
              <div className="text-sm text-white/80">
                {formatDuration(currentTime)} / {formatDuration(duration)}
              </div>
            </div>

            <div className="flex items-center gap-4">
              {/* Subtitles */}
              <button className="p-2 hover:bg-white/10 rounded-full transition-colors">
                <Subtitles className="w-6 h-6" />
              </button>

              {/* Settings */}
              <div className="relative">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                  <Settings className="w-6 h-6" />
                </button>

                {showSettings && (
                  <div className="absolute bottom-full right-0 mb-2 w-64 bg-black/90 backdrop-blur rounded-lg p-4">
                    <h3 className="text-sm font-medium mb-2">Quality</h3>
                    <div className="space-y-1">
                      {content.variants?.map((variant) => (
                        <button
                          key={variant.id}
                          onClick={() => {
                            selectVariant(variant);
                            setShowSettings(false);
                          }}
                          className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm ${
                            selectedVariant?.id === variant.id
                              ? 'bg-white/20'
                              : 'hover:bg-white/10'
                          }`}
                        >
                          <span>{getResolutionLabel(variant.resolution)}</span>
                          <span className="text-white/60">
                            {variant.hdr ? 'HDR' : 'SDR'}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                {isFullscreen ? (
                  <Minimize className="w-6 h-6" />
                ) : (
                  <Maximize className="w-6 h-6" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
