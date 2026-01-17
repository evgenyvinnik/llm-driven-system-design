import { RunResult } from '../types';
import { StatusBadge } from './StatusBadge';

interface TestResultsProps {
  results: RunResult[];
  isLoading?: boolean;
}

export function TestResults({ results, isLoading }: TestResultsProps) {
  if (isLoading) {
    return (
      <div className="p-4 text-center text-gray-400">
        <div className="animate-spin inline-block w-6 h-6 border-2 border-current border-t-transparent rounded-full mr-2"></div>
        Running tests...
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="p-4 text-center text-gray-400">
        Run your code to see test results
      </div>
    );
  }

  const passedCount = results.filter((r) => r.passed === true).length;
  const allPassed = passedCount === results.length && results.every((r) => r.passed !== null);

  return (
    <div className="divide-y divide-dark-100">
      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          {allPassed ? (
            <span className="text-green-400 font-medium">All tests passed!</span>
          ) : (
            <span className="text-gray-300">
              {passedCount} / {results.length} tests passed
            </span>
          )}
        </div>
      </div>

      {results.map((result, index) => (
        <div key={index} className="p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-gray-300 font-medium">Test Case {index + 1}</span>
            <div className="flex items-center gap-2">
              <StatusBadge status={result.passed === true ? 'accepted' : result.passed === false ? 'wrong_answer' : result.status} />
              <span className="text-xs text-gray-500">{result.executionTime}ms</span>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div>
              <span className="text-gray-500">Input:</span>
              <pre className="mt-1 p-2 bg-dark-400 rounded text-gray-300 overflow-x-auto">
                {result.input}
              </pre>
            </div>

            {result.expectedOutput && (
              <div>
                <span className="text-gray-500">Expected:</span>
                <pre className="mt-1 p-2 bg-dark-400 rounded text-gray-300 overflow-x-auto">
                  {result.expectedOutput}
                </pre>
              </div>
            )}

            <div>
              <span className="text-gray-500">Output:</span>
              <pre className="mt-1 p-2 bg-dark-400 rounded text-gray-300 overflow-x-auto">
                {result.actualOutput || '(no output)'}
              </pre>
            </div>

            {result.error && (
              <div>
                <span className="text-red-500">Error:</span>
                <pre className="mt-1 p-2 bg-red-900/20 border border-red-900/50 rounded text-red-300 overflow-x-auto">
                  {result.error}
                </pre>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
