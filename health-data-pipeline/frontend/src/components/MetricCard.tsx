import { ReactNode } from 'react';

interface MetricCardProps {
  title: string;
  value: string | number;
  unit?: string;
  icon: ReactNode;
  color: string;
  trend?: {
    direction: 'up' | 'down' | 'neutral';
    value: string;
  };
  subtitle?: string;
}

export function MetricCard({
  title,
  value,
  unit,
  icon,
  color,
  trend,
  subtitle,
}: MetricCardProps) {
  const colorClasses: Record<string, string> = {
    red: 'bg-red-50 text-red-600 border-red-200',
    blue: 'bg-blue-50 text-blue-600 border-blue-200',
    purple: 'bg-purple-50 text-purple-600 border-purple-200',
    orange: 'bg-orange-50 text-orange-600 border-orange-200',
    cyan: 'bg-cyan-50 text-cyan-600 border-cyan-200',
    green: 'bg-green-50 text-green-600 border-green-200',
    yellow: 'bg-yellow-50 text-yellow-600 border-yellow-200',
  };

  const iconColorClasses: Record<string, string> = {
    red: 'bg-red-100 text-red-600',
    blue: 'bg-blue-100 text-blue-600',
    purple: 'bg-purple-100 text-purple-600',
    orange: 'bg-orange-100 text-orange-600',
    cyan: 'bg-cyan-100 text-cyan-600',
    green: 'bg-green-100 text-green-600',
    yellow: 'bg-yellow-100 text-yellow-600',
  };

  return (
    <div className={`rounded-xl border p-4 ${colorClasses[color] || colorClasses.blue}`}>
      <div className="flex items-start justify-between">
        <div className={`p-2 rounded-lg ${iconColorClasses[color] || iconColorClasses.blue}`}>
          {icon}
        </div>
        {trend && (
          <div
            className={`flex items-center text-sm ${
              trend.direction === 'up'
                ? 'text-green-600'
                : trend.direction === 'down'
                  ? 'text-red-600'
                  : 'text-gray-500'
            }`}
          >
            {trend.direction === 'up' && (
              <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            )}
            {trend.direction === 'down' && (
              <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
            {trend.value}
          </div>
        )}
      </div>
      <div className="mt-3">
        <p className="text-sm font-medium text-gray-600">{title}</p>
        <div className="flex items-baseline mt-1">
          <span className="text-2xl font-bold text-gray-900">{value}</span>
          {unit && <span className="ml-1 text-sm text-gray-500">{unit}</span>}
        </div>
        {subtitle && <p className="mt-1 text-xs text-gray-500">{subtitle}</p>}
      </div>
    </div>
  );
}
