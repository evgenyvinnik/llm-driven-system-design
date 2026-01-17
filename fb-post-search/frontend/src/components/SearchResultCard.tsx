import { Heart, MessageCircle, Share2, Globe, Users, Lock, Image, Video, Link as LinkIcon, FileText } from 'lucide-react';
import type { SearchResult } from '../types';

interface SearchResultCardProps {
  result: SearchResult;
  onHashtagClick?: (hashtag: string) => void;
}

export function SearchResultCard({ result, onHashtagClick }: SearchResultCardProps) {
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours === 0) {
        const diffMinutes = Math.floor(diffMs / (1000 * 60));
        return `${diffMinutes}m ago`;
      }
      return `${diffHours}h ago`;
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      });
    }
  };

  const getVisibilityIcon = () => {
    switch (result.visibility) {
      case 'public':
        return <Globe className="w-4 h-4 text-gray-400" title="Public" />;
      case 'friends':
        return <Users className="w-4 h-4 text-gray-400" title="Friends" />;
      case 'private':
        return <Lock className="w-4 h-4 text-gray-400" title="Private" />;
      default:
        return <Users className="w-4 h-4 text-gray-400" />;
    }
  };

  const getPostTypeIcon = () => {
    switch (result.post_type) {
      case 'photo':
        return <Image className="w-4 h-4 text-blue-500" />;
      case 'video':
        return <Video className="w-4 h-4 text-purple-500" />;
      case 'link':
        return <LinkIcon className="w-4 h-4 text-green-500" />;
      default:
        return <FileText className="w-4 h-4 text-gray-400" />;
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-primary-400 to-primary-600 rounded-full flex items-center justify-center text-white font-semibold">
            {result.author_name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h3 className="font-semibold text-gray-900">{result.author_name}</h3>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <span>{formatDate(result.created_at)}</span>
              <span className="text-gray-300">|</span>
              {getVisibilityIcon()}
              {getPostTypeIcon()}
            </div>
          </div>
        </div>
        <div className="text-xs text-gray-400">
          Score: {result.relevance_score.toFixed(2)}
        </div>
      </div>

      {/* Content with highlighted snippet */}
      <div
        className="text-gray-800 mb-3 search-highlight"
        dangerouslySetInnerHTML={{ __html: result.snippet }}
      />

      {/* Hashtags */}
      {result.hashtags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {result.hashtags.map((hashtag, index) => (
            <button
              key={index}
              onClick={() => onHashtagClick?.(hashtag)}
              className="text-primary-600 hover:text-primary-800 text-sm hover:underline"
            >
              {hashtag}
            </button>
          ))}
        </div>
      )}

      {/* Engagement stats */}
      <div className="flex items-center gap-6 pt-3 border-t border-gray-100">
        <div className="flex items-center gap-1.5 text-gray-500 hover:text-red-500 cursor-pointer">
          <Heart className="w-4 h-4" />
          <span className="text-sm">{result.like_count}</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-500 hover:text-blue-500 cursor-pointer">
          <MessageCircle className="w-4 h-4" />
          <span className="text-sm">{result.comment_count}</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-500 hover:text-green-500 cursor-pointer">
          <Share2 className="w-4 h-4" />
          <span className="text-sm">Share</span>
        </div>
      </div>
    </div>
  );
}
