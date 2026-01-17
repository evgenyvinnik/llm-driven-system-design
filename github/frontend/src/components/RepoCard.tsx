import { Link } from '@tanstack/react-router';
import type { Repository } from '../types';
import { Star, GitFork, Circle } from 'lucide-react';

interface RepoCardProps {
  repo: Repository;
  showOwner?: boolean;
}

const languageColors: Record<string, string> = {
  javascript: '#f1e05a',
  typescript: '#3178c6',
  python: '#3572A5',
  java: '#b07219',
  go: '#00ADD8',
  rust: '#dea584',
  ruby: '#701516',
  php: '#4F5D95',
  c: '#555555',
  cpp: '#f34b7d',
  csharp: '#178600',
  html: '#e34c26',
  css: '#563d7c',
  shell: '#89e051',
};

export function RepoCard({ repo, showOwner = true }: RepoCardProps) {
  const languageColor = repo.language ? languageColors[repo.language.toLowerCase()] || '#8b949e' : null;

  return (
    <div className="border border-github-border rounded-md p-4 hover:border-github-muted transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2">
            <Link
              to={`/${repo.owner_name}/${repo.name}`}
              className="text-github-accent font-semibold hover:underline truncate"
            >
              {showOwner && <span className="text-github-muted font-normal">{repo.owner_name}/</span>}
              {repo.name}
            </Link>
            {repo.is_private && (
              <span className="text-xs px-2 py-0.5 border border-github-border rounded-full text-github-muted">
                Private
              </span>
            )}
          </div>
          {repo.description && (
            <p className="mt-1 text-sm text-github-muted line-clamp-2">{repo.description}</p>
          )}
        </div>
        <button className="ml-4 px-3 py-1 text-xs border border-github-border rounded-md hover:bg-github-border flex items-center space-x-1">
          <Star className="w-3 h-3" />
          <span>Star</span>
        </button>
      </div>

      <div className="mt-3 flex items-center space-x-4 text-xs text-github-muted">
        {repo.language && (
          <span className="flex items-center space-x-1">
            <Circle className="w-3 h-3" style={{ fill: languageColor, color: languageColor }} />
            <span>{repo.language}</span>
          </span>
        )}
        {repo.stars_count > 0 && (
          <Link
            to={`/${repo.owner_name}/${repo.name}/stargazers`}
            className="flex items-center space-x-1 hover:text-github-accent"
          >
            <Star className="w-3 h-3" />
            <span>{repo.stars_count.toLocaleString()}</span>
          </Link>
        )}
        {repo.forks_count > 0 && (
          <Link
            to={`/${repo.owner_name}/${repo.name}/forks`}
            className="flex items-center space-x-1 hover:text-github-accent"
          >
            <GitFork className="w-3 h-3" />
            <span>{repo.forks_count.toLocaleString()}</span>
          </Link>
        )}
        <span>Updated {formatDate(repo.updated_at)}</span>
      </div>
    </div>
  );
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}
