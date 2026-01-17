/**
 * @fileoverview Test Runner component for executing rate limit tests.
 *
 * Provides controls for:
 * - Running single manual tests
 * - Starting/stopping automatic tests at a configurable interval
 * - Clearing test results
 * - Resetting rate limits for the current identifier
 */

import { useState } from 'react';
import { useRateLimiterStore } from '../stores/rateLimiterStore';

/**
 * Test execution controls component.
 * Allows users to run rate limit tests manually or automatically.
 *
 * @returns Test runner controls with buttons and interval configuration
 */
export function TestRunner() {
  const {
    isRunning,
    autoTestInterval,
    runTest,
    startAutoTest,
    stopAutoTest,
    clearResults,
    resetRateLimit,
  } = useRateLimiterStore();

  const [autoTestRate, setAutoTestRate] = useState(500);

  const isAutoRunning = autoTestInterval !== null;

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Test Runner</h2>
      <div className="space-y-4">
        {/* Manual test button */}
        <div className="flex gap-2">
          <button
            onClick={runTest}
            disabled={isRunning}
            className={`flex-1 px-4 py-3 rounded-md font-medium text-white transition-colors ${
              isRunning
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {isRunning ? 'Running...' : 'Send Request'}
          </button>
        </div>

        {/* Auto test controls */}
        <div className="border-t pt-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Auto Test Interval (ms)
          </label>
          <div className="flex gap-2">
            <input
              type="number"
              value={autoTestRate}
              onChange={(e) => setAutoTestRate(parseInt(e.target.value) || 100)}
              min={50}
              max={5000}
              step={50}
              disabled={isAutoRunning}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            />
            {isAutoRunning ? (
              <button
                onClick={stopAutoTest}
                className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 font-medium"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => startAutoTest(autoTestRate)}
                className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 font-medium"
              >
                Start Auto
              </button>
            )}
          </div>
          {isAutoRunning && (
            <p className="text-sm text-green-600 mt-2">
              Auto-sending requests every {autoTestRate}ms
            </p>
          )}
        </div>

        {/* Reset controls */}
        <div className="border-t pt-4 flex gap-2">
          <button
            onClick={clearResults}
            className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 font-medium"
          >
            Clear Results
          </button>
          <button
            onClick={resetRateLimit}
            className="flex-1 px-4 py-2 bg-yellow-100 text-yellow-800 rounded-md hover:bg-yellow-200 font-medium"
          >
            Reset Rate Limit
          </button>
        </div>
      </div>
    </div>
  );
}
