interface CacheStats {
  localHits: number;
  redisHits: number;
  misses: number;
  localCacheSize: number;
  hitRate: number;
}

interface CacheCardProps {
  cache?: CacheStats;
}

export function CacheCard({ cache }: CacheCardProps) {
  if (!cache) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Cache Statistics</h3>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  const totalHits = cache.localHits + cache.redisHits;
  const totalRequests = totalHits + cache.misses;

  return (
    <div className="card">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Cache Statistics</h3>

      <div className="space-y-4">
        {/* Hit Rate */}
        <div>
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="text-gray-600">Hit Rate</span>
            <span className="font-medium text-green-600">{cache.hitRate.toFixed(1)}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-green-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${cache.hitRate}%` }}
            />
          </div>
        </div>

        {/* Cache Breakdown */}
        <div className="grid grid-cols-2 gap-4">
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-primary-600">{cache.localHits}</p>
            <p className="text-xs text-gray-500">Local Hits</p>
          </div>
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-blue-600">{cache.redisHits}</p>
            <p className="text-xs text-gray-500">Redis Hits</p>
          </div>
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-red-600">{cache.misses}</p>
            <p className="text-xs text-gray-500">Misses</p>
          </div>
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-600">{cache.localCacheSize}</p>
            <p className="text-xs text-gray-500">Local Size</p>
          </div>
        </div>

        {/* Summary */}
        <div className="text-sm text-gray-600 text-center">
          {totalRequests} total cache lookups
        </div>
      </div>
    </div>
  );
}
