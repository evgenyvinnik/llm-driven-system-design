import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { FileTree } from '../components/FileTree';
import { Star, GitFork, Eye, Code, GitPullRequest, CircleDot, MessageSquare, Settings, Book } from 'lucide-react';
import type { Repository, TreeItem, Commit } from '../types';

export const Route = createFileRoute('/$owner/$repo')({
  component: RepoPage,
});

function RepoPage() {
  const { owner, repo } = useParams({ from: '/$owner/$repo' });
  const { user } = useAuthStore();
  const [repoData, setRepoData] = useState<Repository | null>(null);
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [readme, setReadme] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState<Commit | null>(null);
  const [isStarred, setIsStarred] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRepo() {
      setLoading(true);
      try {
        const data = await api.getRepo(owner, repo);
        setRepoData(data);

        // Fetch tree
        const treeData = await api.getTree(owner, repo, data.default_branch);
        setTree(treeData);

        // Fetch commits
        const commits = await api.getCommits(owner, repo, data.default_branch, 1);
        if (commits.length > 0) {
          setLastCommit(commits[0]);
        }

        // Check if README exists and fetch it
        const readmeFile = treeData.find(
          (item: TreeItem) => item.name.toLowerCase().startsWith('readme') && item.type === 'file'
        );
        if (readmeFile) {
          const readmeContent = await api.getFileContent(owner, repo, data.default_branch, readmeFile.name);
          setReadme(readmeContent.content);
        }

        // Check if starred
        if (user) {
          const starred = await api.isStarred(owner, repo);
          setIsStarred(starred.starred);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    fetchRepo();
  }, [owner, repo, user]);

  const handleStar = async () => {
    if (!user) return;
    try {
      if (isStarred) {
        await api.unstarRepo(owner, repo);
        setIsStarred(false);
        if (repoData) {
          setRepoData({ ...repoData, stars_count: repoData.stars_count - 1 });
        }
      } else {
        await api.starRepo(owner, repo);
        setIsStarred(true);
        if (repoData) {
          setRepoData({ ...repoData, stars_count: repoData.stars_count + 1 });
        }
      }
    } catch (err) {
      console.error('Star error:', err);
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-github-muted">Loading repository...</div>
      </div>
    );
  }

  if (error || !repoData) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-github-danger">{error || 'Repository not found'}</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-2">
          <Book className="w-5 h-5 text-github-muted" />
          <Link to={`/${owner}`} className="text-github-accent hover:underline text-xl">
            {owner}
          </Link>
          <span className="text-github-muted text-xl">/</span>
          <Link to={`/${owner}/${repo}`} className="text-github-accent hover:underline text-xl font-semibold">
            {repo}
          </Link>
          {repoData.is_private && (
            <span className="text-xs px-2 py-0.5 border border-github-border rounded-full text-github-muted">
              Private
            </span>
          )}
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleStar}
            className={`flex items-center space-x-1 px-3 py-1 border border-github-border rounded-md text-sm hover:bg-github-surface ${
              isStarred ? 'text-github-warning' : 'text-github-text'
            }`}
          >
            <Star className={`w-4 h-4 ${isStarred ? 'fill-current' : ''}`} />
            <span>{isStarred ? 'Starred' : 'Star'}</span>
            <span className="ml-1 px-2 py-0.5 bg-github-surface rounded">{repoData.stars_count}</span>
          </button>
          <button className="flex items-center space-x-1 px-3 py-1 border border-github-border rounded-md text-sm text-github-text hover:bg-github-surface">
            <GitFork className="w-4 h-4" />
            <span>Fork</span>
            <span className="ml-1 px-2 py-0.5 bg-github-surface rounded">{repoData.forks_count}</span>
          </button>
          <button className="flex items-center space-x-1 px-3 py-1 border border-github-border rounded-md text-sm text-github-text hover:bg-github-surface">
            <Eye className="w-4 h-4" />
            <span>Watch</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <nav className="flex items-center space-x-4 border-b border-github-border mb-6">
        <Link
          to={`/${owner}/${repo}`}
          className="flex items-center space-x-1 px-3 py-2 border-b-2 border-github-accent text-white"
        >
          <Code className="w-4 h-4" />
          <span>Code</span>
        </Link>
        <Link
          to={`/${owner}/${repo}/issues`}
          className="flex items-center space-x-1 px-3 py-2 text-github-muted hover:text-white"
        >
          <CircleDot className="w-4 h-4" />
          <span>Issues</span>
        </Link>
        <Link
          to={`/${owner}/${repo}/pulls`}
          className="flex items-center space-x-1 px-3 py-2 text-github-muted hover:text-white"
        >
          <GitPullRequest className="w-4 h-4" />
          <span>Pull requests</span>
        </Link>
        <Link
          to={`/${owner}/${repo}/discussions`}
          className="flex items-center space-x-1 px-3 py-2 text-github-muted hover:text-white"
        >
          <MessageSquare className="w-4 h-4" />
          <span>Discussions</span>
        </Link>
        {user && user.username === owner && (
          <Link
            to={`/${owner}/${repo}/settings`}
            className="flex items-center space-x-1 px-3 py-2 text-github-muted hover:text-white"
          >
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </Link>
        )}
      </nav>

      {/* Branch selector and actions */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-4">
          <select className="px-3 py-1.5 bg-github-surface border border-github-border rounded-md text-sm">
            {repoData.branches?.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
              </option>
            ))}
          </select>
          <span className="text-sm text-github-muted">
            {repoData.branches?.length || 0} branches
          </span>
          <span className="text-sm text-github-muted">
            {repoData.tags?.length || 0} tags
          </span>
        </div>
        <div className="flex items-center space-x-2">
          <button className="px-3 py-1.5 bg-github-success text-white text-sm rounded-md hover:bg-green-600">
            Code
          </button>
        </div>
      </div>

      {/* Last commit */}
      {lastCommit && (
        <div className="flex items-center justify-between px-4 py-2 bg-github-surface border border-github-border rounded-t-md text-sm">
          <div className="flex items-center space-x-2 truncate">
            <span className="text-github-text font-medium">{lastCommit.author.name}</span>
            <span className="text-github-muted truncate">{lastCommit.message}</span>
          </div>
          <div className="flex items-center space-x-4 text-github-muted">
            <Link
              to={`/${owner}/${repo}/commit/${lastCommit.sha}`}
              className="hover:text-github-accent font-mono"
            >
              {lastCommit.sha.slice(0, 7)}
            </Link>
            <span>{formatDate(lastCommit.date)}</span>
          </div>
        </div>
      )}

      {/* File tree */}
      <div className="border-t-0 rounded-b-md overflow-hidden">
        <FileTree
          items={tree}
          owner={owner}
          repo={repo}
          branch={repoData.default_branch}
        />
      </div>

      {/* README */}
      {readme && (
        <div className="mt-6 border border-github-border rounded-md">
          <div className="px-4 py-2 bg-github-surface border-b border-github-border">
            <span className="text-sm font-semibold text-github-text">README.md</span>
          </div>
          <div className="p-6 prose prose-invert max-w-none markdown-body">
            <pre className="whitespace-pre-wrap">{readme}</pre>
          </div>
        </div>
      )}
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
  return date.toLocaleDateString();
}
