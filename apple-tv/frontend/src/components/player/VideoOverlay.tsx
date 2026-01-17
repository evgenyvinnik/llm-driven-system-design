import { Play } from 'lucide-react';
import type { Content } from '../../types';

/**
 * Props for the VideoOverlay component.
 */
interface VideoOverlayProps {
  /** Content being played */
  content: Content;
  /** Whether video is currently playing */
  isPlaying: boolean;
  /** Handler for click on video area (toggle play) */
  onClick: () => void;
}

/**
 * Video display area with thumbnail placeholder and play indicator.
 * In production, this would contain the actual video element.
 * Currently displays content thumbnail with play button overlay when paused.
 *
 * @param props - VideoOverlayProps with content and play state
 * @returns Video placeholder with play button overlay
 */
export function VideoOverlay({ content, isPlaying, onClick }: VideoOverlayProps) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      onClick={onClick}
    >
      <VideoBackground content={content} />
      {!isPlaying && <PlayIndicator />}
    </div>
  );
}

/**
 * Props for the VideoBackground component.
 */
interface VideoBackgroundProps {
  /** Content to display thumbnail for */
  content: Content;
}

/**
 * Background image for the video player.
 * Uses banner or thumbnail image as placeholder.
 * In production, this would be replaced by actual video element.
 *
 * @param props - VideoBackgroundProps with content data
 * @returns Full-screen background image
 */
function VideoBackground({ content }: VideoBackgroundProps) {
  const imageUrl = content.banner_url || content.thumbnail_url;

  return (
    <img
      src={imageUrl}
      alt={content.title}
      className="w-full h-full object-cover opacity-50"
    />
  );
}

/**
 * Large play button indicator shown when video is paused.
 * Centered circular button with blurred background.
 *
 * @returns Centered play button overlay
 */
function PlayIndicator() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <button className="p-6 bg-white/20 rounded-full backdrop-blur">
        <Play className="w-16 h-16 text-white fill-current" />
      </button>
    </div>
  );
}
