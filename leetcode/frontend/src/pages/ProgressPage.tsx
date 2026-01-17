import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { usersApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { DifficultyBadge } from '../components/DifficultyBadge';

interface Progress {
  problem_id: string;
  slug: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  status: 'solved' | 'attempted' | 'unsolved';
  attempts: number;
  best_runtime_ms: number | null;
}

export function ProgressPage() {
  const { isAuthenticated } = useAuthStore();
  const [progress, setProgress] = useState<Progress[]>([]);
  const [totals, setTotals] = useState({ easy: 0, medium: 0, hard: 0 });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'solved' | 'attempted' | 'unsolved'>('all');

  useEffect(() => {
    if (isAuthenticated) {
      loadProgress();
    }
  }, [isAuthenticated]);

  const loadProgress = async () => {
    try {
      const data = await usersApi.getProgress();
      setProgress(data.progress);
      setTotals(data.totals);
    } catch (err) {
      console.error('Failed to load progress:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-64px)]">
        <p className="text-gray-400 mb-4">Please sign in to view your progress</p>
        <Link to="/login" className="text-primary-400 hover:text-primary-300">
          Sign In
        </Link>
      </div>
    );
  }

  const solvedByDifficulty = {
    easy: progress.filter(p => p.status === 'solved' && p.difficulty === 'easy').length,
    medium: progress.filter(p => p.status === 'solved' && p.difficulty === 'medium').length,
    hard: progress.filter(p => p.status === 'solved' && p.difficulty === 'hard').length,
  };

  const totalSolved = solvedByDifficulty.easy + solvedByDifficulty.medium + solvedByDifficulty.hard;
  const totalProblems = totals.easy + totals.medium + totals.hard;

  const filteredProgress = progress.filter(p => {
    if (filter === 'all') return true;
    return p.status === filter;
  });

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Your Progress</h1>
        <p className="text-gray-400">Track your coding journey</p>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin inline-block w-8 h-8 border-2 border-current border-t-transparent text-primary-500 rounded-full"></div>
        </div>
      ) : (
        <>
          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div className="bg-dark-300 rounded-lg p-6">
              <div className="text-3xl font-bold text-white mb-1">{totalSolved}</div>
              <div className="text-gray-400 text-sm">Problems Solved</div>
              <div className="text-gray-500 text-xs mt-1">out of {totalProblems}</div>
            </div>

            <div className="bg-dark-300 rounded-lg p-6">
              <div className="text-3xl font-bold text-green-400 mb-1">{solvedByDifficulty.easy}</div>
              <div className="text-gray-400 text-sm">Easy</div>
              <div className="text-gray-500 text-xs mt-1">out of {totals.easy}</div>
            </div>

            <div className="bg-dark-300 rounded-lg p-6">
              <div className="text-3xl font-bold text-yellow-400 mb-1">{solvedByDifficulty.medium}</div>
              <div className="text-gray-400 text-sm">Medium</div>
              <div className="text-gray-500 text-xs mt-1">out of {totals.medium}</div>
            </div>

            <div className="bg-dark-300 rounded-lg p-6">
              <div className="text-3xl font-bold text-red-400 mb-1">{solvedByDifficulty.hard}</div>
              <div className="text-gray-400 text-sm">Hard</div>
              <div className="text-gray-500 text-xs mt-1">out of {totals.hard}</div>
            </div>
          </div>

          {/* Filter */}
          <div className="flex gap-2 mb-4">
            {(['all', 'solved', 'attempted', 'unsolved'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                  filter === f
                    ? 'bg-primary-500 text-white'
                    : 'bg-dark-300 text-gray-400 hover:text-white'
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Progress Table */}
          <div className="bg-dark-300 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-dark-100">
                  <th className="px-4 py-3 text-left text-gray-400 font-medium w-12">Status</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium">Problem</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium w-24">Difficulty</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium w-20">Attempts</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium w-24">Best Time</th>
                </tr>
              </thead>
              <tbody>
                {filteredProgress.map((item) => (
                  <tr
                    key={item.problem_id}
                    className="border-b border-dark-100 hover:bg-dark-200 transition-colors"
                  >
                    <td className="px-4 py-3">
                      {item.status === 'solved' ? (
                        <span className="text-green-400">&#10003;</span>
                      ) : item.status === 'attempted' ? (
                        <span className="text-yellow-400">&#9679;</span>
                      ) : (
                        <span className="text-gray-600">&#9675;</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/problems/${item.slug}`}
                        className="text-white hover:text-primary-400 transition-colors"
                      >
                        {item.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <DifficultyBadge difficulty={item.difficulty} />
                    </td>
                    <td className="px-4 py-3 text-gray-400">{item.attempts}</td>
                    <td className="px-4 py-3 text-gray-400">
                      {item.best_runtime_ms ? `${item.best_runtime_ms}ms` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filteredProgress.length === 0 && (
              <div className="text-center py-12 text-gray-400">
                No problems found
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
