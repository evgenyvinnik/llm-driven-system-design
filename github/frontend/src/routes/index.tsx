import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { RepoCard } from '../components/RepoCard';
import { Book, Star, Users } from 'lucide-react';
import type { Repository } from '../types';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { user } = useAuthStore();
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchRepos() {
      try {
        const result = await api.getRepos({ limit: 10, sort: 'stars_count' });
        setRepos(result.repos);
      } catch (err) {
        console.error('Failed to fetch repos:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchRepos();
  }, []);

  if (user) {
    return <DashboardView repos={repos} loading={loading} />;
  }

  return <LandingView repos={repos} loading={loading} />;
}

function LandingView({ repos, loading }: { repos: Repository[]; loading: boolean }) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
      {/* Hero */}
      <div className="text-center mb-16">
        <h1 className="text-5xl font-bold text-white mb-4">
          Where the world builds software
        </h1>
        <p className="text-xl text-github-muted mb-8">
          Millions of developers use GitHub to build, ship, and maintain their software.
        </p>
        <div className="flex justify-center space-x-4">
          <Link
            to="/register"
            className="px-8 py-3 bg-github-success text-white font-semibold rounded-md hover:bg-green-600"
          >
            Sign up for GitHub
          </Link>
          <Link
            to="/explore"
            className="px-8 py-3 border border-github-border text-github-text font-semibold rounded-md hover:border-github-muted"
          >
            Explore repositories
          </Link>
        </div>
      </div>

      {/* Features */}
      <div className="grid md:grid-cols-3 gap-8 mb-16">
        <div className="p-6 border border-github-border rounded-lg">
          <Book className="w-8 h-8 text-github-accent mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">Code hosting</h3>
          <p className="text-github-muted">
            Host and manage your Git repositories with powerful tools for code review and collaboration.
          </p>
        </div>
        <div className="p-6 border border-github-border rounded-lg">
          <Star className="w-8 h-8 text-github-warning mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">Open source</h3>
          <p className="text-github-muted">
            Discover and contribute to millions of open source projects from around the world.
          </p>
        </div>
        <div className="p-6 border border-github-border rounded-lg">
          <Users className="w-8 h-8 text-github-success mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">Community</h3>
          <p className="text-github-muted">
            Join a community of developers building the future of software together.
          </p>
        </div>
      </div>

      {/* Popular repos */}
      <div>
        <h2 className="text-2xl font-bold text-white mb-6">Popular repositories</h2>
        {loading ? (
          <div className="text-github-muted">Loading...</div>
        ) : (
          <div className="space-y-4">
            {repos.map((repo) => (
              <RepoCard key={repo.id} repo={repo} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DashboardView({ repos, loading }: { repos: Repository[]; loading: boolean }) {
  const { user } = useAuthStore();
  const [userRepos, setUserRepos] = useState<Repository[]>([]);

  useEffect(() => {
    if (user) {
      api.getUserRepos(user.username).then(setUserRepos).catch(console.error);
    }
  }, [user]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="grid lg:grid-cols-4 gap-8">
        {/* Left sidebar */}
        <div className="lg:col-span-1">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-github-text">Your repositories</h2>
            <Link
              to="/new"
              className="text-xs px-2 py-1 bg-github-success text-white rounded-md hover:bg-green-600"
            >
              New
            </Link>
          </div>
          <div className="space-y-2">
            {userRepos.map((repo) => (
              <Link
                key={repo.id}
                to={`/${user?.username}/${repo.name}`}
                className="block text-sm text-github-text hover:text-github-accent"
              >
                {repo.name}
              </Link>
            ))}
            {userRepos.length === 0 && (
              <p className="text-sm text-github-muted">No repositories yet</p>
            )}
          </div>
        </div>

        {/* Main content */}
        <div className="lg:col-span-3">
          <h2 className="text-xl font-bold text-white mb-6">Explore repositories</h2>
          {loading ? (
            <div className="text-github-muted">Loading...</div>
          ) : (
            <div className="space-y-4">
              {repos.map((repo) => (
                <RepoCard key={repo.id} repo={repo} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
