import { useRef, useCallback } from 'react';

interface VideoPlayerProps {
  videoUrl: string | null;
  status: string;
  /** Still frame shown before playback begins, and while the first frame loads. */
  posterUrl?: string | null;
  onTimeUpdate?: (time: number) => void;
}

/** HTML5 video player with playback controls and time update callbacks for comment anchoring. */
export function VideoPlayer({ videoUrl, status, posterUrl, onTimeUpdate }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current && onTimeUpdate) {
      onTimeUpdate(videoRef.current.currentTime);
    }
  }, [onTimeUpdate]);

  if (status === 'processing') {
    return (
      <div className="aspect-video bg-gray-100 rounded-lg flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-loom-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-loom-secondary">Processing video...</p>
        </div>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="aspect-video bg-red-50 rounded-lg flex items-center justify-center">
        <p className="text-loom-danger">Video processing failed</p>
      </div>
    );
  }

  if (!videoUrl) {
    return (
      <div className="aspect-video bg-gray-100 rounded-lg flex items-center justify-center">
        <p className="text-loom-secondary">Video not available</p>
      </div>
    );
  }

  return (
    <div className="aspect-video bg-black rounded-lg overflow-hidden">
      <video
        ref={videoRef}
        src={videoUrl}
        poster={posterUrl ?? undefined}
        preload="metadata"
        controls
        className="w-full h-full"
        onTimeUpdate={handleTimeUpdate}
      >
        Your browser does not support the video element.
      </video>
    </div>
  );
}
