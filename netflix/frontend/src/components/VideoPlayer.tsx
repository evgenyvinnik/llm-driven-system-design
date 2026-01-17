import React from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  SkipBack,
  SkipForward,
  ArrowLeft,
} from 'lucide-react';
import { usePlayerStore } from '../stores/playerStore';

interface VideoPlayerProps {
  videoId: string;
  episodeId?: string;
  title: string;
  subtitle?: string;
}

export function VideoPlayer({ videoId, episodeId, title, subtitle }: VideoPlayerProps) {
  const navigate = useNavigate();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = React.useRef<NodeJS.Timeout>();

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

  const [showQualityMenu, setShowQualityMenu] = React.useState(false);

  // Load manifest on mount
  React.useEffect(() => {
    loadManifest(videoId, episodeId);
  }, [videoId, episodeId, loadManifest]);

  // Save progress periodically
  React.useEffect(() => {
    const interval = setInterval(() => {
      if (isPlaying && currentTime > 0) {
        saveProgress();
      }
    }, 10000); // Every 10 seconds

    return () => clearInterval(interval);
  }, [isPlaying, currentTime, saveProgress]);

  // Save progress on unmount
  React.useEffect(() => {
    return () => {
      saveProgress();
    };
  }, [saveProgress]);

  // Keyboard controls
  React.useEffect(() => {
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
            navigate({ to: '/browse' });
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [volume, isFullscreen, navigate, setVolume, toggleMute]);

  // Auto-hide controls
  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
    }
  };

  const skip = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime += seconds;
    }
  };

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

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);

      // Resume from saved position
      if (manifest?.resumePosition) {
        videoRef.current.currentTime = manifest.resumePosition;
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    setCurrentTime(time);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value);
    setVolume(vol);
    if (videoRef.current) {
      videoRef.current.volume = vol;
    }
  };

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Get stream URL - for demo, use a sample video
  const streamUrl = currentQuality?.url || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
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
        onEnded={() => navigate({ to: '/browse' })}
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
        {/* Top bar */}
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/70 to-transparent">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate({ to: '/browse' })}
              className="text-white hover:text-netflix-light-gray"
            >
              <ArrowLeft size={28} />
            </button>
            <div>
              <h1 className="text-white text-xl font-bold">{title}</h1>
              {subtitle && <p className="text-netflix-light-gray text-sm">{subtitle}</p>}
            </div>
          </div>
        </div>

        {/* Center play button */}
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            onClick={togglePlay}
            className="w-20 h-20 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition-colors"
          >
            {isPlaying ? (
              <Pause size={40} className="text-white" />
            ) : (
              <Play size={40} fill="white" className="text-white ml-1" />
            )}
          </button>
        </div>

        {/* Bottom controls */}
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/70 to-transparent">
          {/* Progress bar */}
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
            />
            <div className="flex justify-between text-xs text-netflix-light-gray mt-1">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Control buttons */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Play/Pause */}
              <button onClick={togglePlay} className="text-white hover:text-netflix-light-gray">
                {isPlaying ? <Pause size={28} /> : <Play size={28} />}
              </button>

              {/* Skip back */}
              <button onClick={() => skip(-10)} className="text-white hover:text-netflix-light-gray">
                <SkipBack size={24} />
              </button>

              {/* Skip forward */}
              <button onClick={() => skip(10)} className="text-white hover:text-netflix-light-gray">
                <SkipForward size={24} />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleMute()}
                  className="text-white hover:text-netflix-light-gray"
                >
                  {isMuted || volume === 0 ? <VolumeX size={24} /> : <Volume2 size={24} />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-20 h-1 bg-zinc-600 rounded appearance-none cursor-pointer
                            [&::-webkit-slider-thumb]:appearance-none
                            [&::-webkit-slider-thumb]:w-3
                            [&::-webkit-slider-thumb]:h-3
                            [&::-webkit-slider-thumb]:rounded-full
                            [&::-webkit-slider-thumb]:bg-white"
                />
              </div>
            </div>

            <div className="flex items-center gap-4">
              {/* Quality selector */}
              <div className="relative">
                <button
                  onClick={() => setShowQualityMenu(!showQualityMenu)}
                  className="text-white hover:text-netflix-light-gray flex items-center gap-1"
                >
                  <Settings size={24} />
                  <span className="text-sm">{currentQuality?.quality || 'Auto'}</span>
                </button>

                {showQualityMenu && manifest?.qualities && (
                  <div className="absolute bottom-full right-0 mb-2 bg-black/90 rounded py-2 min-w-32">
                    {manifest.qualities.map((q) => (
                      <button
                        key={q.quality}
                        onClick={() => {
                          setQuality(q);
                          setShowQualityMenu(false);
                        }}
                        className={`w-full px-4 py-2 text-left text-sm hover:bg-zinc-700 ${
                          currentQuality?.quality === q.quality
                            ? 'text-netflix-red'
                            : 'text-white'
                        }`}
                      >
                        {q.quality} ({Math.round(q.bitrate / 1000)}Mbps)
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="text-white hover:text-netflix-light-gray"
              >
                {isFullscreen ? <Minimize size={24} /> : <Maximize size={24} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
