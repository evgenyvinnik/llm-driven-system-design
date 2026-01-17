/**
 * HeroBanner Component
 *
 * Large featured content banner displayed at the top of the browse page.
 * Shows featured video with backdrop image, title, description, and action buttons.
 * Includes gradient overlays for text readability.
 */
import React from 'react';
import { Link } from '@tanstack/react-router';
import { Play, Info } from 'lucide-react';
import type { Video } from '../types';

/** Props for HeroBanner component */
interface HeroBannerProps {
  /** Video to feature in the banner */
  video: Video;
}

/**
 * Hero banner for featuring a video on the homepage.
 * Displays large backdrop with overlaid content info and action buttons.
 */
export function HeroBanner({ video }: HeroBannerProps) {
  // Use a placeholder backdrop for demo
  const backdropUrl = video.backdropUrl || '/placeholder-backdrop.jpg';

  return (
    <div className="relative h-[80vh] min-h-[500px]">
      {/* Background image */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{
          backgroundImage: `url(${backdropUrl})`,
          backgroundColor: '#333',
        }}
      >
        {/* Gradient overlays */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/40 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-netflix-black via-transparent to-transparent" />
      </div>

      {/* Content */}
      <div className="absolute bottom-0 left-0 right-0 px-4 md:px-12 pb-20 md:pb-32">
        <div className="max-w-xl">
          {/* Title */}
          <h1 className="text-4xl md:text-6xl font-bold text-shadow mb-4">
            {video.title}
          </h1>

          {/* Metadata */}
          <div className="flex items-center gap-3 text-sm text-netflix-light-gray mb-4">
            {video.releaseYear && <span>{video.releaseYear}</span>}
            {video.rating && (
              <span className="px-2 py-0.5 border border-netflix-gray text-xs">
                {video.rating}
              </span>
            )}
            {video.type === 'movie' && video.durationMinutes && (
              <span>{Math.floor(video.durationMinutes / 60)}h {video.durationMinutes % 60}m</span>
            )}
            {video.type === 'series' && <span>Series</span>}
          </div>

          {/* Description */}
          <p className="text-white/90 text-sm md:text-base leading-relaxed mb-6 line-clamp-3">
            {video.description}
          </p>

          {/* Genres */}
          <div className="flex flex-wrap gap-2 mb-6">
            {video.genres.slice(0, 3).map((genre) => (
              <span
                key={genre}
                className="text-xs text-netflix-light-gray"
              >
                {genre}
              </span>
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <Link
              to="/watch/$videoId"
              params={{ videoId: video.id }}
              className="flex items-center gap-2 bg-white text-black px-6 py-2 rounded font-semibold hover:bg-white/80 transition-colors"
            >
              <Play size={20} fill="black" />
              Play
            </Link>
            <Link
              to="/video/$videoId"
              params={{ videoId: video.id }}
              className="flex items-center gap-2 bg-zinc-500/70 text-white px-6 py-2 rounded font-semibold hover:bg-zinc-500/50 transition-colors"
            >
              <Info size={20} />
              More Info
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
