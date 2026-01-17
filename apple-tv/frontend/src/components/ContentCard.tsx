import { Link } from '@tanstack/react-router';
import type { Content } from '../types';
import { Play, Plus, Check } from 'lucide-react';
import { useState, useEffect } from 'react';
import { watchlistApi } from '../services/api';
import { formatDurationHuman } from '../utils';

interface ContentCardProps {
  content: Content;
  size?: 'small' | 'medium' | 'large';
  showProgress?: boolean;
  progressPercent?: number;
}

export function ContentCard({ content, size = 'medium', showProgress, progressPercent }: ContentCardProps) {
  const [inWatchlist, setInWatchlist] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    const checkWatchlist = async () => {
      try {
        const result = await watchlistApi.check(content.id);
        setInWatchlist(result.inWatchlist);
      } catch {
        // Ignore errors
      }
    };
    checkWatchlist();
  }, [content.id]);

  const handleWatchlistToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (inWatchlist) {
        await watchlistApi.remove(content.id);
        setInWatchlist(false);
      } else {
        await watchlistApi.add(content.id);
        setInWatchlist(true);
      }
    } catch (error) {
      console.error('Watchlist error:', error);
    }
  };

  const sizeClasses = {
    small: 'w-40 h-24',
    medium: 'w-56 h-32',
    large: 'w-80 h-44',
  };

  return (
    <Link
      to="/content/$contentId"
      params={{ contentId: content.id }}
      className="group flex-shrink-0"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className={`relative ${sizeClasses[size]} rounded-lg overflow-hidden`}>
        {/* Thumbnail */}
        <img
          src={content.thumbnail_url}
          alt={content.title}
          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
        />

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

        {/* Progress bar */}
        {showProgress && typeof progressPercent === 'number' && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/30">
            <div
              className="h-full bg-white"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}

        {/* Hover overlay */}
        {isHovered && (
          <div className="absolute inset-0 flex items-center justify-center gap-2">
            <button className="p-3 bg-white/90 rounded-full text-black hover:bg-white transition-colors">
              <Play className="w-5 h-5 fill-current" />
            </button>
            <button
              onClick={handleWatchlistToggle}
              className="p-3 bg-white/20 rounded-full text-white hover:bg-white/30 transition-colors"
            >
              {inWatchlist ? <Check className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
            </button>
          </div>
        )}

        {/* HDR badge */}
        {content.hdr_format && (
          <div className="absolute top-2 right-2 px-2 py-0.5 bg-black/60 rounded text-xs font-medium">
            HDR
          </div>
        )}
      </div>

      {/* Title and metadata */}
      <div className="mt-2">
        <h3 className="text-sm font-medium text-white truncate group-hover:text-apple-blue transition-colors">
          {content.title}
        </h3>
        <div className="flex items-center gap-2 text-xs text-white/60">
          {content.content_type === 'episode' && content.season_number && (
            <span>S{content.season_number} E{content.episode_number}</span>
          )}
          {content.duration > 0 && (
            <span>{formatDurationHuman(content.duration)}</span>
          )}
          {content.rating && <span>{content.rating}</span>}
        </div>
      </div>
    </Link>
  );
}
