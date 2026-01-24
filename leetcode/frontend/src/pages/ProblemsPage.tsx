import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { problemsApi } from '../services/api';
import { DifficultyBadge } from '../components/DifficultyBadge';
import { useAuthStore } from '../stores/authStore';

interface Problem {
  id: string;
  title: string;
  slug: string;
  difficulty: 'easy' | 'medium' | 'hard';
  userStatus?: 'solved' | 'attempted' | 'unsolved';
}

export function ProblemsPage() {
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<string>('');
  const [search, setSearch] = useState('');
  const { isAuthenticated } = useAuthStore();
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadProblems();
  }, [difficulty]);

  const loadProblems = async () => {
    try {
      setLoading(true);
      const response = await problemsApi.list({ difficulty: difficulty || undefined });
      setProblems(response.problems);
      setError(null);
    } catch (err) {
      setError('Failed to load problems');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const filteredProblems = problems.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase())
  );

  // Virtualization for efficient rendering of large problem lists
  const rowVirtualizer = useVirtualizer({
    count: filteredProblems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // Estimated row height in pixels
    overscan: 10, // Extra rows to render above/below viewport
  });

  const getStatusIcon = (status?: string) => {
    switch (status) {
      case 'solved':
        return <span className="text-green-400">&#10003;</span>;
      case 'attempted':
        return <span className="text-yellow-400">&#9679;</span>;
      default:
        return <span className="text-gray-600">&#9675;</span>;
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Problems</h1>
        <p className="text-gray-400">Practice coding problems to improve your skills</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6">
        <input
          type="text"
          placeholder="Search problems..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-4 py-2 bg-dark-300 border border-dark-100 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 w-full md:w-64"
        />

        <select
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value)}
          className="px-4 py-2 bg-dark-300 border border-dark-100 rounded-lg text-white focus:outline-none focus:border-primary-500"
        >
          <option value="">All Difficulties</option>
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
      </div>

      {/* Problem List */}
      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin inline-block w-8 h-8 border-2 border-current border-t-transparent text-primary-500 rounded-full"></div>
        </div>
      ) : error ? (
        <div className="text-center py-12 text-red-400">{error}</div>
      ) : (
        <div className="bg-dark-300 rounded-lg overflow-hidden">
          {/* Table Header - always visible */}
          <div className="border-b border-dark-100">
            <div className="flex">
              {isAuthenticated && (
                <div className="px-4 py-3 text-left text-gray-400 font-medium w-16">Status</div>
              )}
              <div className="px-4 py-3 text-left text-gray-400 font-medium flex-1">Title</div>
              <div className="px-4 py-3 text-left text-gray-400 font-medium w-32">Difficulty</div>
            </div>
          </div>

          {/* Virtualized List Container */}
          <div
            ref={parentRef}
            className="overflow-auto"
            style={{ height: 'calc(100vh - 320px)', minHeight: '400px' }}
          >
            {filteredProblems.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                No problems found
              </div>
            ) : (
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const problem = filteredProblems[virtualRow.index];
                  return (
                    <div
                      key={problem.id}
                      className="absolute top-0 left-0 w-full flex border-b border-dark-100 hover:bg-dark-200 transition-colors"
                      style={{
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      {isAuthenticated && (
                        <div className="px-4 py-3 w-16 flex items-center">
                          {getStatusIcon(problem.userStatus)}
                        </div>
                      )}
                      <div className="px-4 py-3 flex-1 flex items-center">
                        <Link
                          to={`/problems/${problem.slug}`}
                          className="text-white hover:text-primary-400 transition-colors"
                        >
                          {problem.title}
                        </Link>
                      </div>
                      <div className="px-4 py-3 w-32 flex items-center">
                        <DifficultyBadge difficulty={problem.difficulty} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
