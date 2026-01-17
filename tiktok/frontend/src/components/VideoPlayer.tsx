import { useRef, useEffect, useState } from 'react';
import { Video } from '@/types';
import { useFeedStore } from '@/stores/feedStore';

interface VideoPlayerProps {
  video: Video;
  isActive: boolean;
}

export default function VideoPlayer({ video, isActive }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const startTimeRef = useRef<number>(0);
  const { recordView } = useFeedStore();

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    if (isActive) {
      videoElement.play().catch(() => {
        // Autoplay might be blocked, show play button
        setIsPlaying(false);
      });
      startTimeRef.current = Date.now();
    } else {
      videoElement.pause();
      videoElement.currentTime = 0;

      // Record view when leaving
      if (startTimeRef.current > 0) {
        const watchDurationMs = Date.now() - startTimeRef.current;
        const duration = videoElement.duration || 1;
        const completionRate = Math.min(videoElement.currentTime / duration, 1);
        recordView(video.id, watchDurationMs, completionRate);
        startTimeRef.current = 0;
      }
    }
  }, [isActive, video.id, recordView]);

  const handleTimeUpdate = () => {
    const videoElement = videoRef.current;
    if (videoElement) {
      const prog = (videoElement.currentTime / videoElement.duration) * 100;
      setProgress(prog);
    }
  };

  const togglePlay = () => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    if (videoElement.paused) {
      videoElement.play();
      setIsPlaying(true);
    } else {
      videoElement.pause();
      setIsPlaying(false);
    }
  };

  const handlePlay = () => setIsPlaying(true);
  const handlePause = () => setIsPlaying(false);

  return (
    <div className="relative h-full w-full bg-black flex items-center justify-center" onClick={togglePlay}>
      <video
        ref={videoRef}
        src={video.videoUrl}
        className="h-full w-full object-contain"
        loop
        muted
        playsInline
        onTimeUpdate={handleTimeUpdate}
        onPlay={handlePlay}
        onPause={handlePause}
        poster={video.thumbnailUrl || undefined}
      />

      {/* Play/Pause overlay */}
      {!isPlaying && isActive && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-16 h-16 bg-black/50 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Progress bar */}
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-800">
        <div
          className="h-full bg-white transition-all duration-100"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
