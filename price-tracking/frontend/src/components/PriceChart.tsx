import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { format } from 'date-fns';
import { DailyPrice } from '../types';

interface PriceChartProps {
  data: DailyPrice[];
  currency?: string;
  targetPrice?: number | null;
}

export function PriceChart({ data, currency = 'USD', targetPrice }: PriceChartProps) {
  const formatPrice = (price: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(price);
  };

  const chartData = data.map((d) => ({
    date: format(new Date(d.day), 'MMM d'),
    rawDate: d.day,
    min: d.min_price,
    max: d.max_price,
    avg: d.avg_price,
  }));

  const allPrices = data.flatMap((d) => [d.min_price, d.max_price]);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const padding = (maxPrice - minPrice) * 0.1;

  if (data.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center bg-gray-50 rounded-lg">
        <p className="text-gray-500">No price history available yet</p>
      </div>
    );
  }

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 12 }}
            tickLine={false}
          />
          <YAxis
            domain={[Math.floor(minPrice - padding), Math.ceil(maxPrice + padding)]}
            tick={{ fontSize: 12 }}
            tickFormatter={(value) => `$${value}`}
            tickLine={false}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (active && payload && payload.length) {
                return (
                  <div className="bg-white p-3 rounded-lg shadow-lg border">
                    <p className="font-medium">{label}</p>
                    <p className="text-sm text-gray-600">
                      Avg: {formatPrice(payload[0]?.value as number)}
                    </p>
                    <p className="text-sm text-gray-600">
                      Min: {formatPrice(payload[1]?.value as number)}
                    </p>
                    <p className="text-sm text-gray-600">
                      Max: {formatPrice(payload[2]?.value as number)}
                    </p>
                  </div>
                );
              }
              return null;
            }}
          />
          <Line
            type="monotone"
            dataKey="avg"
            stroke="#2563eb"
            strokeWidth={2}
            dot={false}
            name="Average"
          />
          <Line
            type="monotone"
            dataKey="min"
            stroke="#10b981"
            strokeWidth={1}
            strokeDasharray="5 5"
            dot={false}
            name="Min"
          />
          <Line
            type="monotone"
            dataKey="max"
            stroke="#ef4444"
            strokeWidth={1}
            strokeDasharray="5 5"
            dot={false}
            name="Max"
          />
          {targetPrice && (
            <ReferenceLine
              y={targetPrice}
              stroke="#f59e0b"
              strokeDasharray="3 3"
              label={{ value: 'Target', fill: '#f59e0b', fontSize: 12 }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
