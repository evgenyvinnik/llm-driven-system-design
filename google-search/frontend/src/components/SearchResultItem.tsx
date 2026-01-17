import type { SearchResult } from '@/types';
import { ExternalLink } from 'lucide-react';

interface SearchResultItemProps {
  result: SearchResult;
}

export function SearchResultItem({ result }: SearchResultItemProps) {
  const displayUrl = result.url.replace(/^https?:\/\//, '').replace(/\/$/, '');

  return (
    <article className="max-w-[600px] mb-8">
      {/* URL and domain */}
      <div className="flex items-center gap-2 mb-1">
        <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
          <span className="text-xs font-medium text-gray-600">
            {result.domain.charAt(0).toUpperCase()}
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-sm text-gray-600 truncate">{result.domain}</p>
          <p className="text-xs text-gray-500 truncate">{displayUrl}</p>
        </div>
      </div>

      {/* Title */}
      <h3 className="mb-1">
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xl text-search-blue hover:underline inline-flex items-center gap-1"
          dangerouslySetInnerHTML={{
            __html: result.highlight?.title?.[0] || result.title || 'Untitled Page'
          }}
        />
      </h3>

      {/* Snippet */}
      {result.snippet && (
        <p
          className="text-sm text-search-gray leading-relaxed"
          dangerouslySetInnerHTML={{ __html: result.snippet }}
        />
      )}
      {!result.snippet && result.description && (
        <p className="text-sm text-search-gray leading-relaxed">
          {result.description}
        </p>
      )}

      {/* Meta info */}
      <div className="mt-2 flex items-center gap-4 text-xs text-gray-400">
        {result.page_rank > 0 && (
          <span>Rank: {(result.page_rank * 100).toFixed(4)}</span>
        )}
        {result.fetch_time && (
          <span>
            Indexed: {new Date(result.fetch_time).toLocaleDateString()}
          </span>
        )}
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-search-blue hover:underline"
        >
          <ExternalLink className="w-3 h-3" />
          Open
        </a>
      </div>
    </article>
  );
}
