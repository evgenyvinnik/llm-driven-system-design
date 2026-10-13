import { useRef, useCallback, useEffect } from 'react';

interface VideoPlayerProps {
  videoUrl: string | null;
  status: string;
  /** Still frame shown before playback begins, and while the first frame loads. */
  posterUrl?: string | null;
  onTimeUpdate?: (time: number, duration: number) => void;
  onPlay?: () => void;
  onEnded?: () => void;
  /** Seeks when this changes; the nonce lets the same moment be requested twice. */
  seekRequest?: { time: number; nonce: number } | null;
}

/** HTML5 video player with playback controls and time update callbacks for comment anchoring. */
export function VideoPlayer({
  videoUrl,
  status,
  posterUrl,
  onTimeUpdate,
  onPlay,
  onEnded,
  seekRequest,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current && onTimeUpdate) {
      onTimeUpdate(videoRef.current.currentTime, videoRef.current.duration);
    }
  }, [onTimeUpdate]);

  useEffect(() => {
    const video = videoRef.current;
    if (!seekRequest || !video) return;
    video.currentTime = seekRequest.time;
    video.play().catch(() => undefined);
  }, [seekRequest]);

  if (status === 'uploading') {
    return (
      <div className="aspect-video bg-gray-100 rounded-lg flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-loom-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-loom-secondary">Still uploading from the recorder...</p>
        </div>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="aspect-video bg-red-50 rounded-lg flex items-center justify-center">
        <p className="text-loom-danger">This recording did not finish uploading</p>
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

  // 'processing' videos are already playable from the original upload.
  return (
    <div>
      <div className="aspect-video bg-black rounded-lg overflow-hidden">
        <video
          ref={videoRef}
          src={videoUrl}
          poster={posterUrl ?? undefined}
          preload="metadata"
          controls
          className="w-full h-full"
          onTimeUpdate={handleTimeUpdate}
          onPlay={onPlay}
          onEnded={onEnded}
        >
          Your browser does not support the video element.
        </video>
      </div>
      {status === 'processing' && (
        <p className="text-xs text-loom-secondary mt-2">
          Processing: seeking and the thumbnail improve in a moment.
        </p>
      )}
    </div>
  );
}
