interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  color?: 'blue' | 'green' | 'red' | 'yellow' | 'purple';
}

const colorClasses = {
  blue: 'bg-blue-50 border-blue-200 text-blue-700',
  green: 'bg-green-50 border-green-200 text-green-700',
  red: 'bg-red-50 border-red-200 text-red-700',
  yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
  purple: 'bg-purple-50 border-purple-200 text-purple-700',
};

export function StatCard({ title, value, subtitle, trend, trendValue, color = 'blue' }: StatCardProps) {
  return (
    <div className={`rounded-lg border p-6 ${colorClasses[color]}`}>
      <h3 className="text-sm font-medium opacity-80">{title}</h3>
      <div className="mt-2 flex items-baseline gap-2">
        <p className="text-3xl font-semibold tracking-tight">
          {typeof value === 'number' ? value.toLocaleString() : value}
        </p>
        {trend && trendValue && (
          <span
            className={`text-sm font-medium ${
              trend === 'up' ? 'text-green-600' : trend === 'down' ? 'text-red-600' : 'text-gray-500'
            }`}
          >
            {trend === 'up' ? '+' : trend === 'down' ? '-' : ''}
            {trendValue}
          </span>
        )}
      </div>
      {subtitle && <p className="mt-1 text-sm opacity-70">{subtitle}</p>}
    </div>
  );
}
