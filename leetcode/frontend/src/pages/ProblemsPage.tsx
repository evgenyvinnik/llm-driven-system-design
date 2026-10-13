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

const PAGE_SIZE = 500;
const ROW_HEIGHT = 48;

/** Renders a virtualized problem list with difficulty filtering, search, and solve-status indicators. */
export function ProblemsPage() {
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<string>('');
  const [search, setSearch] = useState('');
  const { isAuthenticated } = useAuthStore();
  const parentRef = useRef<HTMLDivElement>(null);

  // The catalog index is small (~100 bytes per problem), so load every page once and filter
  // in memory. The cancelled flag drops responses for a filter the user already changed.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const all: Problem[] = [];
        for (let page = 1, pages = 1; page <= pages; page++) {
          const response = await problemsApi.list({ difficulty: difficulty || undefined, page, limit: PAGE_SIZE });
          all.push(...response.problems);
          pages = response.pagination.pages;
        }
        if (!cancelled) {
          setProblems(all);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load problems');
          console.error(err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [difficulty]);

  const filteredProblems = problems.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase())
  );

  // Virtualization for efficient rendering of large problem lists
  const rowVirtualizer = useVirtualizer({
    count: filteredProblems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT, // Fixed row height in pixels
    overscan: 10, // Extra rows to render above/below viewport
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0
    ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;
  const columnCount = isAuthenticated ? 3 : 2;

  const getStatusIcon = (status?: string) => {
    switch (status) {
      case 'solved':
        return <span className="text-green-400" role="img" aria-label="Solved">&#10003;</span>;
      case 'attempted':
        return <span className="text-yellow-400" role="img" aria-label="Attempted">&#9679;</span>;
      default:
        return <span className="text-gray-600" role="img" aria-label="Not attempted">&#9675;</span>;
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
          aria-label="Search problems"
          placeholder="Search problems..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-4 py-2 bg-dark-300 border border-dark-100 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 w-full md:w-64"
        />

        <select
          aria-label="Difficulty"
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
          {/* A real table (screen readers announce rows and columns); virtualization keeps only
              the visible rows in the DOM and pads the rest with two spacer rows. */}
          <div
            ref={parentRef}
            className="overflow-auto"
            style={{ height: 'calc(100vh - 320px)', minHeight: '400px' }}
          >
            <table className="w-full text-left" aria-rowcount={filteredProblems.length + 1}>
              <thead className="sticky top-0 z-10 bg-dark-300 border-b border-dark-100">
                <tr>
                  {isAuthenticated && (
                    <th scope="col" className="px-4 py-3 text-gray-400 font-medium w-16">Status</th>
                  )}
                  <th scope="col" className="px-4 py-3 text-gray-400 font-medium">Title</th>
                  <th scope="col" className="px-4 py-3 text-gray-400 font-medium w-32">Difficulty</th>
                </tr>
              </thead>
              <tbody>
                {filteredProblems.length === 0 ? (
                  <tr>
                    <td colSpan={columnCount} className="text-center py-12 text-gray-400">
                      No problems found
                    </td>
                  </tr>
                ) : (
                  <>
                    {paddingTop > 0 && (
                      <tr aria-hidden="true">
                        <td colSpan={columnCount} style={{ height: `${paddingTop}px`, padding: 0 }} />
                      </tr>
                    )}
                    {virtualRows.map((virtualRow) => {
                      const problem = filteredProblems[virtualRow.index];
                      return (
                        <tr
                          key={problem.id}
                          aria-rowindex={virtualRow.index + 2}
                          className="border-b border-dark-100 hover:bg-dark-200 transition-colors"
                          style={{ height: `${virtualRow.size}px` }}
                        >
                          {isAuthenticated && (
                            <td className="px-4 py-3 w-16">{getStatusIcon(problem.userStatus)}</td>
                          )}
                          <td className="px-4 py-3">
                            <Link
                              to={`/problems/${problem.slug}`}
                              className="text-white hover:text-primary-400 transition-colors"
                            >
                              {problem.title}
                            </Link>
                          </td>
                          <td className="px-4 py-3 w-32">
                            <DifficultyBadge difficulty={problem.difficulty} />
                          </td>
                        </tr>
                      );
                    })}
                    {paddingBottom > 0 && (
                      <tr aria-hidden="true">
                        <td colSpan={columnCount} style={{ height: `${paddingBottom}px`, padding: 0 }} />
                      </tr>
                    )}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
