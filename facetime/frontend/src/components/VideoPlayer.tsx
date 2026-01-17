/**
 * VideoPlayer Component
 *
 * Renders a video stream in a styled container with optional mirroring,
 * muting, and label overlay. Handles cases where no stream is available.
 */

import { useRef, useEffect } from 'react';

/**
 * Props for the VideoPlayer component.
 */
interface VideoPlayerProps {
  /** MediaStream to display, null shows placeholder */
  stream: MediaStream | null;
  /** Whether audio should be muted (typically for local preview) */
  muted?: boolean;
  /** Whether to mirror the video horizontally (for self-view) */
  mirror?: boolean;
  /** Additional CSS classes for the container */
  className?: string;
  /** Optional label to display in the bottom-left corner */
  label?: string;
}

/**
 * Displays a video stream with optional controls and styling.
 *
 * @param props - VideoPlayer configuration options
 * @returns Video element with stream attached or placeholder if no stream
 */
export function VideoPlayer({
  stream,
  muted = false,
  mirror = false,
  className = '',
  label,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className={`relative ${className}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`w-full h-full object-cover rounded-2xl ${
          mirror ? 'transform scale-x-[-1]' : ''
        }`}
      />
      {label && (
        <div className="absolute bottom-4 left-4 bg-black/50 px-3 py-1 rounded-full text-sm">
          {label}
        </div>
      )}
      {!stream && (
        <div className="absolute inset-0 flex items-center justify-center bg-facetime-gray rounded-2xl">
          <div className="text-gray-400">No video</div>
        </div>
      )}
    </div>
  );
}
