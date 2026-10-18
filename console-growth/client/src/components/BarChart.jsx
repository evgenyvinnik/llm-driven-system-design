import { formatShortDate } from '../lib/format.js';

// A plain bar chart for daily series: one bar per day, height relative to the busiest day.
export default function BarChart({ data, valueKey, formatValue, variant }) {
  const max = Math.max(...data.map((point) => point[valueKey]), 0);
  const labelEvery = data.length > 14 ? 3 : data.length > 7 ? 2 : 1;
  return (
    <div className="chart" role="img" aria-label={`Daily ${valueKey}`}>
      {data.map((point, index) => (
        <div key={point.date} className="chart-col" title={`${formatShortDate(point.date)}: ${formatValue(point[valueKey])}`}>
          <div
            className={`chart-bar${variant === 'secondary' ? ' secondary' : ''}`}
            style={{ height: `${max > 0 ? (point[valueKey] / max) * 100 : 0}%` }}
          />
          <span className="chart-label">{index % labelEvery === 0 ? formatShortDate(point.date) : ' '}</span>
        </div>
      ))}
    </div>
  );
}
