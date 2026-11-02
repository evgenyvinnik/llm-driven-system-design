import { escapeHtml } from '../utils/format';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useWikiStore } from '../stores/wikiStore';
import { useAuthStore } from '../stores/authStore';
import SpaceCard from '../components/SpaceCard';
import { formatDate } from '../utils/format';
import * as api from '../services/api';
import type { SearchResult } from '../types';

interface SearchParams {
  q?: string;
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    q: search.q as string | undefined,
  }),
  component: Dashboard,
});

function Dashboard() {
  const { q } = Route.useSearch();
  const { spaces, recentPages, loadSpaces, loadRecentPages } = useWikiStore();
  const { user } = useAuthStore();
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  useEffect(() => {
    loadSpaces();
    loadRecentPages();
  }, [loadSpaces, loadRecentPages]);

  useEffect(() => {
    if (q) {
      setSearchLoading(true);
      api.searchPages(q).then(({ results }) => {
        setSearchResults(results);
        setSearchLoading(false);
      }).catch(() => {
        setSearchLoading(false);
      });
    } else {
      setSearchResults([]);
    }
  }, [q]);

  if (q) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold text-confluence-text mb-6">
          Search results for "{q}"
        </h1>
        {searchLoading ? (
          <div className="text-confluence-text-subtle">Searching...</div>
        ) : searchResults.length === 0 ? (
          <div className="text-confluence-text-subtle">No results found.</div>
        ) : (
          <div className="space-y-4">
            {searchResults.map((result) => (
              <Link
                key={result.page_id}
                to="/space/$spaceKey/page/$slug"
                params={{ spaceKey: result.space_key, slug: result.slug }}
                className="block p-4 bg-white rounded-lg border border-confluence-border hover:shadow-md transition-shadow"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-confluence-primary bg-confluence-info px-2 py-0.5 rounded">
                    {result.space_key}
                  </span>
                </div>
                <h3
                  className="text-lg font-medium text-confluence-primary"
                  dangerouslySetInnerHTML={{
                    // Highlights arrive HTML-escaped with only <mark> tags; plain
                    // fallbacks must be escaped here or a page title could inject markup.
                    __html: result.highlight?.title?.[0] || escapeHtml(result.title),
                  }}
                />
                <p
                  className="text-sm text-confluence-text-subtle mt-1 line-clamp-2"
                  dangerouslySetInnerHTML={{
                    __html: result.highlight?.content_text?.[0] || escapeHtml(result.content_text.substring(0, 200)),
                  }}
                />
                {result.labels.length > 0 && (
                  <div className="flex gap-1 mt-2">
                    {result.labels.map((label) => (
                      <span key={label} className="text-xs bg-confluence-sidebar text-confluence-text-subtle px-2 py-0.5 rounded">
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-confluence-text">
          {user ? `Welcome back, ${user.display_name || user.username}` : 'Welcome to Confluence'}
        </h1>
        <p className="text-confluence-text-subtle mt-1">
          Your team's knowledge base and documentation hub
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Recent Pages */}
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold text-confluence-text mb-4">
            Recently Updated
          </h2>
          <div className="space-y-3">
            {recentPages.length === 0 ? (
              <p className="text-confluence-text-subtle">No pages yet.</p>
            ) : (
              recentPages.map((page) => (
                <Link
                  key={page.id}
                  to="/space/$spaceKey/page/$slug"
                  params={{
                    spaceKey: page.space_key || 'ENG',
                    slug: page.slug,
                  }}
                  className="block p-4 bg-white rounded-lg border border-confluence-border hover:shadow-md transition-shadow"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-confluence-primary bg-confluence-info px-2 py-0.5 rounded">
                      {page.space_key || ''}
                    </span>
                    <span className="text-xs text-confluence-text-muted">
                      {formatDate(page.updated_at)}
                    </span>
                  </div>
                  <h3 className="text-base font-medium text-confluence-text hover:text-confluence-primary">
                    {page.title}
                  </h3>
                  <p className="text-sm text-confluence-text-subtle mt-1 line-clamp-2">
                    {page.content_text?.substring(0, 150)}
                  </p>
                  <p className="text-xs text-confluence-text-muted mt-2">
                    by {page.author_username || 'unknown'}
                  </p>
                </Link>
              ))
            )}
          </div>
        </div>

        {/* Spaces */}
        <div>
          <h2 className="text-lg font-semibold text-confluence-text mb-4">
            Spaces
          </h2>
          <div className="space-y-3">
            {spaces.map((space) => (
              <SpaceCard key={space.id} space={space} />
            ))}
          </div>
          {user && (
            <Link
              to="/"
              className="mt-4 inline-block text-sm text-confluence-primary hover:underline"
            >
              Create a new space
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
