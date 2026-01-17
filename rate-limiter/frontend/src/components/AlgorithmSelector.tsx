/**
 * @fileoverview Algorithm Selector component for choosing rate limiting algorithms.
 *
 * Displays all available algorithms as clickable buttons and shows
 * detailed information about the selected algorithm including:
 * - Description of how the algorithm works
 * - Pros and cons
 * - Required parameters
 */

import { useEffect } from 'react';
import { useRateLimiterStore } from '../stores/rateLimiterStore';
import type { Algorithm } from '../types';

/**
 * Algorithm selection component with documentation display.
 * Fetches available algorithms from the backend and displays them
 * with interactive selection and detailed information.
 *
 * @returns Algorithm selector with documentation panel
 */
export function AlgorithmSelector() {
  const {
    algorithm,
    setAlgorithm,
    algorithms,
    fetchAlgorithms,
  } = useRateLimiterStore();

  useEffect(() => {
    fetchAlgorithms();
  }, [fetchAlgorithms]);

  const selectedAlgorithm = algorithms.find((a) => a.name === algorithm);

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Algorithm</h2>
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {algorithms.map((algo) => (
            <button
              key={algo.name}
              onClick={() => setAlgorithm(algo.name as Algorithm)}
              className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                algorithm === algo.name
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {formatAlgorithmName(algo.name)}
            </button>
          ))}
        </div>

        {selectedAlgorithm && (
          <div className="bg-gray-50 rounded p-4 mt-4">
            <h3 className="font-medium mb-2">{formatAlgorithmName(selectedAlgorithm.name)}</h3>
            <p className="text-sm text-gray-600 mb-3">{selectedAlgorithm.description}</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-green-700 font-semibold uppercase">Pros</p>
                <ul className="text-sm text-gray-600 list-disc list-inside">
                  {selectedAlgorithm.pros.map((pro, i) => (
                    <li key={i}>{pro}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs text-red-700 font-semibold uppercase">Cons</p>
                <ul className="text-sm text-gray-600 list-disc list-inside">
                  {selectedAlgorithm.cons.map((con, i) => (
                    <li key={i}>{con}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Format algorithm name from snake_case to Title Case.
 *
 * @param name - Algorithm name in snake_case
 * @returns Formatted name with spaces and capitalization
 */
function formatAlgorithmName(name: string): string {
  return name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
