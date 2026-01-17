import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  ListMusic
} from 'lucide-react';
import { usePlayerStore } from '../stores/playerStore';
import { useEffect, useRef, useState } from 'react';

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function Player() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [showQueue, setShowQueue] = useState(false);

  const {
    currentTrack,
    queue,
    queueIndex,
    isPlaying,
    volume,
    isMuted,
    progress,
    duration,
    isShuffled,
    repeatMode,
    setAudioElement,
    togglePlay,
    next,
    previous,
    seekTo,
    setVolume,
    toggleMute,
    toggleShuffle,
    setRepeatMode,
    updateProgress,
    removeFromQueue,
  } = usePlayerStore();

  useEffect(() => {
    if (audioRef.current) {
      setAudioElement(audioRef.current);

      audioRef.current.addEventListener('timeupdate', () => {
        if (audioRef.current) {
          updateProgress(audioRef.current.currentTime, audioRef.current.duration || 0);
        }
      });

      audioRef.current.addEventListener('ended', () => {
        next();
      });
    }
  }, [setAudioElement, updateProgress, next]);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    seekTo(parseFloat(e.target.value));
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(parseFloat(e.target.value));
  };

  const cycleRepeatMode = () => {
    const modes: ('off' | 'all' | 'one')[] = ['off', 'all', 'one'];
    const currentIndex = modes.indexOf(repeatMode);
    setRepeatMode(modes[(currentIndex + 1) % modes.length]);
  };

  if (!currentTrack) {
    return (
      <div className="fixed bottom-0 left-0 right-0 h-20 bg-apple-card border-t border-apple-border flex items-center justify-center">
        <p className="text-apple-text-secondary">Select a song to play</p>
        <audio ref={audioRef} className="hidden" />
      </div>
    );
  }

  return (
    <>
      <div className="fixed bottom-0 left-0 right-0 h-24 bg-apple-card/95 backdrop-blur-lg border-t border-apple-border z-50">
        <div className="flex items-center justify-between h-full px-4 max-w-screen-2xl mx-auto">
          {/* Track Info */}
          <div className="flex items-center gap-4 w-64">
            <div className="w-14 h-14 rounded-lg bg-apple-border flex-shrink-0 overflow-hidden">
              {currentTrack.artwork_url ? (
                <img
                  src={currentTrack.artwork_url}
                  alt={currentTrack.album_title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full artwork-placeholder" />
              )}
            </div>
            <div className="min-w-0">
              <p className="font-medium truncate">{currentTrack.title}</p>
              <p className="text-sm text-apple-text-secondary truncate">
                {currentTrack.artist_name}
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-col items-center gap-2 flex-1 max-w-xl">
            <div className="flex items-center gap-4">
              <button
                onClick={toggleShuffle}
                className={`p-2 rounded-full hover:bg-white/10 transition ${
                  isShuffled ? 'text-apple-pink' : 'text-white/60'
                }`}
              >
                <Shuffle className="w-4 h-4" />
              </button>

              <button
                onClick={previous}
                className="p-2 rounded-full hover:bg-white/10 transition"
              >
                <SkipBack className="w-5 h-5" />
              </button>

              <button
                onClick={togglePlay}
                className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition"
              >
                {isPlaying ? (
                  <Pause className="w-5 h-5" />
                ) : (
                  <Play className="w-5 h-5 ml-0.5" />
                )}
              </button>

              <button
                onClick={next}
                className="p-2 rounded-full hover:bg-white/10 transition"
              >
                <SkipForward className="w-5 h-5" />
              </button>

              <button
                onClick={cycleRepeatMode}
                className={`p-2 rounded-full hover:bg-white/10 transition ${
                  repeatMode !== 'off' ? 'text-apple-pink' : 'text-white/60'
                }`}
              >
                {repeatMode === 'one' ? (
                  <Repeat1 className="w-4 h-4" />
                ) : (
                  <Repeat className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* Progress Bar */}
            <div className="flex items-center gap-2 w-full">
              <span className="text-xs text-apple-text-secondary w-10 text-right">
                {formatTime(progress)}
              </span>
              <input
                type="range"
                min="0"
                max={duration || 0}
                value={progress}
                onChange={handleSeek}
                className="flex-1 h-1 cursor-pointer"
              />
              <span className="text-xs text-apple-text-secondary w-10">
                {formatTime(duration)}
              </span>
            </div>
          </div>

          {/* Volume & Queue */}
          <div className="flex items-center gap-4 w-64 justify-end">
            <button
              onClick={() => setShowQueue(!showQueue)}
              className={`p-2 rounded-full hover:bg-white/10 transition ${
                showQueue ? 'text-apple-pink' : 'text-white/60'
              }`}
            >
              <ListMusic className="w-5 h-5" />
            </button>

            <button
              onClick={toggleMute}
              className="p-2 rounded-full hover:bg-white/10 transition"
            >
              {isMuted ? (
                <VolumeX className="w-5 h-5 text-white/60" />
              ) : (
                <Volume2 className="w-5 h-5" />
              )}
            </button>

            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              className="w-24 h-1 cursor-pointer"
            />
          </div>
        </div>

        <audio ref={audioRef} className="hidden" />
      </div>

      {/* Queue Panel */}
      {showQueue && (
        <div className="fixed bottom-24 right-4 w-80 max-h-96 bg-apple-card border border-apple-border rounded-xl shadow-2xl overflow-hidden z-40">
          <div className="p-4 border-b border-apple-border">
            <h3 className="font-semibold">Play Queue</h3>
            <p className="text-sm text-apple-text-secondary">{queue.length} tracks</p>
          </div>
          <div className="overflow-y-auto max-h-72">
            {queue.map((track, index) => (
              <div
                key={`${track.id}-${index}`}
                className={`flex items-center gap-3 p-3 hover:bg-white/5 ${
                  index === queueIndex ? 'bg-white/10' : ''
                }`}
              >
                <span className="text-sm text-apple-text-secondary w-6">
                  {index + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{track.title}</p>
                  <p className="text-xs text-apple-text-secondary truncate">
                    {track.artist_name}
                  </p>
                </div>
                {index !== queueIndex && (
                  <button
                    onClick={() => removeFromQueue(index)}
                    className="text-apple-text-secondary hover:text-white text-sm"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
