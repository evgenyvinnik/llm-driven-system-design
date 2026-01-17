import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from 'recharts';
import type { HealthAggregate } from '../types';

interface HealthChartProps {
  data: HealthAggregate[];
  title: string;
  color: string;
  unit: string;
  type?: 'line' | 'area';
  showMinMax?: boolean;
}

export function HealthChart({
  data,
  title,
  color,
  unit,
  type = 'line',
  showMinMax = false,
}: HealthChartProps) {
  const formattedData = data.map((item) => ({
    ...item,
    date: new Date(item.date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    }),
    value: Math.round(item.value * 10) / 10,
  }));

  const colorMap: Record<string, string> = {
    red: '#ef4444',
    blue: '#3b82f6',
    purple: '#8b5cf6',
    orange: '#f97316',
    cyan: '#06b6d4',
    green: '#22c55e',
    yellow: '#eab308',
  };

  const strokeColor = colorMap[color] || colorMap.blue;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">{title}</h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          {type === 'area' ? (
            <AreaChart data={formattedData}>
              <defs>
                <linearGradient id={`gradient-${color}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={strokeColor} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={strokeColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
                axisLine={{ stroke: '#e5e7eb' }}
              />
              <YAxis
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
                axisLine={{ stroke: '#e5e7eb' }}
                unit={` ${unit}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                }}
                formatter={(value: number) => [`${value} ${unit}`, 'Value']}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={strokeColor}
                strokeWidth={2}
                fill={`url(#gradient-${color})`}
              />
            </AreaChart>
          ) : (
            <LineChart data={formattedData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
                axisLine={{ stroke: '#e5e7eb' }}
              />
              <YAxis
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
                axisLine={{ stroke: '#e5e7eb' }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                }}
                formatter={(value: number) => [`${value} ${unit}`, 'Value']}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={strokeColor}
                strokeWidth={2}
                dot={{ fill: strokeColor, strokeWidth: 0, r: 3 }}
                activeDot={{ r: 5, fill: strokeColor }}
              />
              {showMinMax && (
                <>
                  <Line
                    type="monotone"
                    dataKey="minValue"
                    stroke={strokeColor}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    dot={false}
                    opacity={0.5}
                  />
                  <Line
                    type="monotone"
                    dataKey="maxValue"
                    stroke={strokeColor}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    dot={false}
                    opacity={0.5}
                  />
                </>
              )}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
