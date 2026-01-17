import type { HealthInsight } from '../types';

interface InsightCardProps {
  insight: HealthInsight;
  onAcknowledge?: (id: string) => void;
}

export function InsightCard({ insight, onAcknowledge }: InsightCardProps) {
  const severityColors = {
    positive: 'bg-green-50 border-green-200',
    medium: 'bg-yellow-50 border-yellow-200',
    high: 'bg-red-50 border-red-200',
  };

  const severityIconColors = {
    positive: 'text-green-500',
    medium: 'text-yellow-500',
    high: 'text-red-500',
  };

  const typeIcons: Record<string, JSX.Element> = {
    HEART_RATE_TREND: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      </svg>
    ),
    SLEEP_DEFICIT: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
      </svg>
    ),
    SLEEP_OPTIMAL: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
      </svg>
    ),
    ACTIVITY_CHANGE: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
      </svg>
    ),
    WEIGHT_CHANGE: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
      </svg>
    ),
  };

  return (
    <div
      className={`rounded-lg border p-4 ${severityColors[insight.severity] || severityColors.medium} ${
        insight.acknowledged ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={severityIconColors[insight.severity] || severityIconColors.medium}>
          {typeIcons[insight.type] || (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </div>
        <div className="flex-1">
          <p className="font-medium text-gray-900">{insight.message}</p>
          {insight.recommendation && (
            <p className="mt-1 text-sm text-gray-600">{insight.recommendation}</p>
          )}
          <div className="mt-2 flex items-center gap-4">
            <span className="text-xs text-gray-500">
              {new Date(insight.created_at).toLocaleDateString()}
            </span>
            {!insight.acknowledged && onAcknowledge && (
              <button
                onClick={() => onAcknowledge(insight.id)}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                Acknowledge
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
