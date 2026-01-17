// Test Configuration Component

import { useRateLimiterStore } from '../stores/rateLimiterStore';

export function TestConfiguration() {
  const {
    identifier,
    algorithm,
    limit,
    windowSeconds,
    burstCapacity,
    refillRate,
    leakRate,
    setIdentifier,
    setLimit,
    setWindowSeconds,
    setBurstCapacity,
    setRefillRate,
    setLeakRate,
  } = useRateLimiterStore();

  const showWindowConfig = ['fixed_window', 'sliding_window', 'sliding_log'].includes(algorithm);
  const showBucketConfig = ['token_bucket', 'leaky_bucket'].includes(algorithm);
  const showTokenConfig = algorithm === 'token_bucket';
  const showLeakyConfig = algorithm === 'leaky_bucket';

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Configuration</h2>
      <div className="space-y-4">
        {/* Identifier */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Identifier
          </label>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g., user-123, api-key-abc"
          />
          <p className="text-xs text-gray-500 mt-1">
            The unique identifier for rate limiting (API key, user ID, IP, etc.)
          </p>
        </div>

        {/* Window-based algorithm config */}
        {showWindowConfig && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Limit (requests)
                </label>
                <input
                  type="number"
                  value={limit}
                  onChange={(e) => setLimit(parseInt(e.target.value) || 1)}
                  min={1}
                  max={10000}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Window (seconds)
                </label>
                <input
                  type="number"
                  value={windowSeconds}
                  onChange={(e) => setWindowSeconds(parseInt(e.target.value) || 1)}
                  min={1}
                  max={3600}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <p className="text-xs text-gray-500">
              Allow {limit} requests per {windowSeconds} second{windowSeconds !== 1 ? 's' : ''}
            </p>
          </>
        )}

        {/* Bucket-based algorithm config */}
        {showBucketConfig && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Bucket Capacity
              </label>
              <input
                type="number"
                value={burstCapacity}
                onChange={(e) => setBurstCapacity(parseInt(e.target.value) || 1)}
                min={1}
                max={1000}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Maximum burst capacity
              </p>
            </div>

            {showTokenConfig && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Refill Rate (tokens/second)
                </label>
                <input
                  type="number"
                  value={refillRate}
                  onChange={(e) => setRefillRate(parseFloat(e.target.value) || 0.1)}
                  min={0.1}
                  max={100}
                  step={0.1}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Tokens added per second ({(burstCapacity / refillRate).toFixed(1)}s to refill from empty)
                </p>
              </div>
            )}

            {showLeakyConfig && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Leak Rate (requests/second)
                </label>
                <input
                  type="number"
                  value={leakRate}
                  onChange={(e) => setLeakRate(parseFloat(e.target.value) || 0.1)}
                  min={0.1}
                  max={100}
                  step={0.1}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Requests processed per second ({(burstCapacity / leakRate).toFixed(1)}s to drain full bucket)
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
