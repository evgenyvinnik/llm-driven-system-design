/**
 * Video Player Component
 *
 * Displays the video player or a placeholder for the live stream.
 * Shows a LIVE indicator and handles video autoplay.
 *
 * @module components/VideoPlayer
 */

import { useRef, useEffect } from 'react';
import { Stream } from '../types';

/** Props for the VideoPlayer component */
interface VideoPlayerProps {
  /** Stream to display */
  stream: Stream;
}

/**
 * Renders a video player for the current stream.
 * Falls back to a placeholder if no video URL is provided.
 *
 * @param props - Component props containing the stream
 * @returns Video player JSX
 */
export function VideoPlayer({ stream }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream.video_url) {
      videoRef.current.play().catch(() => {
        // Autoplay might be blocked, that's okay
      });
    }
  }, [stream.video_url]);

  return (
    <div className="relative w-full h-full bg-black rounded-lg overflow-hidden">
      {stream.video_url ? (
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          src={stream.video_url}
          loop
          muted
          playsInline
          controls={false}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800">
          <div className="text-center">
            <div className="text-6xl mb-4">&#127909;</div>
            <p className="text-gray-400 text-lg">{stream.title}</p>
            <p className="text-gray-500 text-sm mt-2">Live stream simulation</p>
          </div>
        </div>
      )}

      {/* Live indicator */}
      <div className="absolute top-4 left-4 flex items-center gap-2">
        <span className="bg-red-600 text-white text-xs font-bold px-2 py-1 rounded animate-pulse-glow">
          LIVE
        </span>
      </div>
    </div>
  );
}
