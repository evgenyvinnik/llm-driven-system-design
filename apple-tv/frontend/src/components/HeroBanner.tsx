import { Link } from '@tanstack/react-router';
import { Play, Plus, Info } from 'lucide-react';
import type { Content } from '../types';
import { formatDurationHuman, formatYear } from '../utils';

interface HeroBannerProps {
  content: Content;
}

export function HeroBanner({ content }: HeroBannerProps) {
  return (
    <div className="relative h-[70vh] min-h-[500px] w-full">
      {/* Background image */}
      <div className="absolute inset-0">
        <img
          src={content.banner_url || content.thumbnail_url}
          alt={content.title}
          className="w-full h-full object-cover"
        />
        {/* Gradient overlays */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-transparent to-transparent" />
      </div>

      {/* Content */}
      <div className="absolute bottom-0 left-0 right-0 p-8 lg:p-16">
        <div className="max-w-2xl">
          {/* Title */}
          <h1 className="text-4xl lg:text-6xl font-bold mb-4 animate-slide-up">
            {content.title}
          </h1>

          {/* Metadata */}
          <div className="flex items-center gap-4 text-sm text-white/80 mb-4">
            {content.release_date && (
              <span>{formatYear(content.release_date)}</span>
            )}
            {content.duration > 0 && (
              <span>{formatDurationHuman(content.duration)}</span>
            )}
            {content.rating && (
              <span className="px-2 py-0.5 border border-white/40 rounded">
                {content.rating}
              </span>
            )}
            {content.hdr_format && (
              <span className="px-2 py-0.5 bg-white/20 rounded text-xs font-medium">
                4K HDR
              </span>
            )}
          </div>

          {/* Genres */}
          {content.genres && content.genres.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-white/60 mb-4">
              {content.genres.slice(0, 3).map((genre, index) => (
                <span key={genre}>
                  {genre}
                  {index < Math.min(content.genres.length, 3) - 1 && ' · '}
                </span>
              ))}
            </div>
          )}

          {/* Description */}
          <p className="text-base lg:text-lg text-white/80 mb-6 line-clamp-3">
            {content.description}
          </p>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <Link
              to="/watch/$contentId"
              params={{ contentId: content.id }}
              className="flex items-center gap-2 px-8 py-3 bg-white text-black font-semibold rounded-lg hover:bg-white/90 transition-colors"
            >
              <Play className="w-5 h-5 fill-current" />
              Play
            </Link>
            <button className="flex items-center gap-2 px-6 py-3 bg-white/20 text-white font-semibold rounded-lg hover:bg-white/30 transition-colors">
              <Plus className="w-5 h-5" />
              My List
            </button>
            <Link
              to="/content/$contentId"
              params={{ contentId: content.id }}
              className="flex items-center gap-2 px-6 py-3 bg-white/10 text-white font-semibold rounded-lg hover:bg-white/20 transition-colors"
            >
              <Info className="w-5 h-5" />
              Details
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
