import { useRef, useEffect } from 'react';

interface VideoPlayerProps {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  className?: string;
  label?: string;
}

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
