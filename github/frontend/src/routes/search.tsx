import { createFileRoute, useSearch } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { RepoCard } from '../components/RepoCard';
import { Search, Code, Book, User, CircleDot } from 'lucide-react';

export const Route = createFileRoute('/search')({
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>) => ({
    q: (search.q as string) || '',
    type: (search.type as string) || 'all',
  }),
});

function SearchPage() {
  const { q, type } = useSearch({ from: '/search' });
  const [results, setResults] = useState<{
    repositories: any[];
    issues: any[];
    users: any[];
  }>({ repositories: [], issues: [], users: [] });
  const [codeResults, setCodeResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState(type);

  useEffect(() => {
    if (!q) return;

    async function search() {
      setLoading(true);
      try {
        if (activeTab === 'code') {
          const data = await api.searchCode(q);
          setCodeResults(data.results);
        } else {
          const data = await api.search(q, activeTab === 'all' ? undefined : activeTab);
          setResults(data);
        }
      } catch (err) {
        console.error('Search failed:', err);
      } finally {
        setLoading(false);
      }
    }
    search();
  }, [q, activeTab]);

  const tabs = [
    { id: 'all', label: 'All', icon: Search },
    { id: 'repositories', label: 'Repositories', icon: Book },
    { id: 'code', label: 'Code', icon: Code },
    { id: 'issues', label: 'Issues', icon: CircleDot },
    { id: 'users', label: 'Users', icon: User },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="grid lg:grid-cols-4 gap-6">
        {/* Sidebar with tabs */}
        <div className="lg:col-span-1">
          <nav className="space-y-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center space-x-2 px-3 py-2 rounded-md text-sm ${
                  activeTab === tab.id
                    ? 'bg-github-surface text-white font-semibold'
                    : 'text-github-muted hover:text-white hover:bg-github-surface/50'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                <span>{tab.label}</span>
                {activeTab === tab.id && tab.id !== 'all' && tab.id !== 'code' && (
                  <span className="ml-auto text-xs bg-github-border px-2 py-0.5 rounded-full">
                    {tab.id === 'repositories' && results.repositories.length}
                    {tab.id === 'issues' && results.issues.length}
                    {tab.id === 'users' && results.users.length}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Results */}
        <div className="lg:col-span-3">
          {!q ? (
            <div className="text-center py-16">
              <Search className="w-12 h-12 text-github-muted mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-white mb-2">Search GitHub</h3>
              <p className="text-github-muted">Enter a search term to find repositories, code, issues, and users.</p>
            </div>
          ) : loading ? (
            <div className="text-github-muted py-8 text-center">Searching...</div>
          ) : (
            <div className="space-y-6">
              {/* Repositories */}
              {(activeTab === 'all' || activeTab === 'repositories') && results.repositories.length > 0 && (
                <div>
                  <h2 className="text-lg font-semibold text-white mb-4">Repositories</h2>
                  <div className="space-y-4">
                    {results.repositories.map((repo) => (
                      <RepoCard key={repo.id} repo={repo} />
                    ))}
                  </div>
                </div>
              )}

              {/* Code */}
              {activeTab === 'code' && (
                <div>
                  <h2 className="text-lg font-semibold text-white mb-4">Code results</h2>
                  {codeResults.length === 0 ? (
                    <p className="text-github-muted">No code results found.</p>
                  ) : (
                    <div className="space-y-4">
                      {codeResults.map((result, index) => (
                        <div key={index} className="border border-github-border rounded-md">
                          <div className="px-4 py-2 bg-github-surface border-b border-github-border">
                            <a
                              href={`/${result.owner}/${result.repo_name}/blob/main/${result.path}`}
                              className="text-github-accent hover:underline"
                            >
                              {result.owner}/{result.repo_name}/{result.path}
                            </a>
                          </div>
                          <div className="p-4">
                            {result.highlights.map((highlight: string, i: number) => (
                              <pre
                                key={i}
                                className="text-sm text-github-text font-mono bg-github-bg p-2 rounded mb-2"
                                dangerouslySetInnerHTML={{ __html: highlight }}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Issues */}
              {(activeTab === 'all' || activeTab === 'issues') && results.issues.length > 0 && (
                <div>
                  <h2 className="text-lg font-semibold text-white mb-4">Issues</h2>
                  <div className="border border-github-border rounded-md">
                    {results.issues.map((issue) => (
                      <a
                        key={issue.id}
                        href={`/${issue.owner_name}/${issue.repo_name}/issues/${issue.number}`}
                        className="block px-4 py-3 border-b border-github-border last:border-b-0 hover:bg-github-surface/50"
                      >
                        <div className="flex items-start space-x-3">
                          <CircleDot className={`w-4 h-4 mt-1 ${issue.state === 'open' ? 'text-github-success' : 'text-purple-500'}`} />
                          <div>
                            <span className="text-github-text font-semibold">{issue.title}</span>
                            <p className="text-xs text-github-muted mt-1">
                              {issue.owner_name}/{issue.repo_name} #{issue.number}
                            </p>
                          </div>
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Users */}
              {(activeTab === 'all' || activeTab === 'users') && results.users.length > 0 && (
                <div>
                  <h2 className="text-lg font-semibold text-white mb-4">Users</h2>
                  <div className="space-y-2">
                    {results.users.map((user) => (
                      <a
                        key={user.id}
                        href={`/${user.username}`}
                        className="flex items-center space-x-3 p-3 border border-github-border rounded-md hover:bg-github-surface/50"
                      >
                        <div className="w-10 h-10 rounded-full bg-github-accent flex items-center justify-center text-white font-semibold">
                          {user.username.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <span className="text-github-text font-semibold">{user.username}</span>
                          {user.display_name && (
                            <p className="text-sm text-github-muted">{user.display_name}</p>
                          )}
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* No results */}
              {activeTab !== 'code' &&
                results.repositories.length === 0 &&
                results.issues.length === 0 &&
                results.users.length === 0 && (
                  <div className="text-center py-16">
                    <Search className="w-12 h-12 text-github-muted mx-auto mb-4" />
                    <h3 className="text-xl font-semibold text-white mb-2">No results found</h3>
                    <p className="text-github-muted">
                      We couldn't find anything matching '{q}'
                    </p>
                  </div>
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
