import { useMemo } from 'react';
import type { AppComponent } from '../../types';
import { useBindingContext } from '../../stores/dataStore';
import { resolveBindingValue, hasBindings } from '../../utils/bindings';

interface ChartWidgetProps {
  component: AppComponent;
  isEditor?: boolean;
}

/** Renders a chart widget with configurable chart type and data bindings. */
export function ChartWidget({ component }: ChartWidgetProps) {
  const context = useBindingContext();

  const chartType = (component.props.type as string) || 'bar';
  const title = (component.props.title as string) || '';
  const xKey = (component.props.xKey as string) || '';
  const yKey = (component.props.yKey as string) || '';

  // Resolve data
  const data = useMemo(() => {
    const dataStr = component.props.data;
    if (typeof dataStr === 'string' && hasBindings(dataStr)) {
      const resolved = resolveBindingValue(dataStr, context);
      if (Array.isArray(resolved)) return resolved as Record<string, unknown>[];
    }
    if (Array.isArray(component.props.data)) return component.props.data as Record<string, unknown>[];
    return [];
  }, [component.props.data, context]);

  if (data.length === 0 || !xKey || !yKey) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-retool-secondary p-4">
        <div className="text-center">
          <div className="font-medium mb-1">Chart ({chartType})</div>
          <div className="text-xs">Set data, xKey, and yKey</div>
        </div>
      </div>
    );
  }

  // Simple SVG chart rendering
  const values = data.map((d) => Number(d[yKey]) || 0);
  const maxValue = Math.max(...values, 1);
  const labels = data.map((d) => String(d[xKey] || ''));

  return (
    <div className="flex flex-col h-full p-3">
      {title && (
        <div className="text-sm font-semibold text-retool-text mb-2">{title}</div>
      )}
      <div className="flex-1 relative">
        <svg viewBox={`0 0 ${data.length * 60 + 40} 200`} className="w-full h-full">
          {/* Y axis */}
          <line x1="30" y1="10" x2="30" y2="170" stroke="#E5E7EB" strokeWidth="1" />
          {/* X axis */}
          <line x1="30" y1="170" x2={data.length * 60 + 30} y2="170" stroke="#E5E7EB" strokeWidth="1" />

          {chartType === 'bar' ? (
            // Bar chart
            data.map((_, i) => {
              const barHeight = (values[i] / maxValue) * 150;
              const x = 40 + i * 60;
              const y = 170 - barHeight;
              return (
                <g key={i}>
                  <rect
                    x={x}
                    y={y}
                    width={40}
                    height={barHeight}
                    fill="#4B48EC"
                    rx={2}
                    opacity={0.85}
                  />
                  <text x={x + 20} y="185" textAnchor="middle" fontSize="8" fill="#6B7280">
                    {labels[i].substring(0, 8)}
                  </text>
                  <text x={x + 20} y={y - 4} textAnchor="middle" fontSize="8" fill="#1C1C1E">
                    {values[i]}
                  </text>
                </g>
              );
            })
          ) : (
            // Line chart
            <>
              <polyline
                fill="none"
                stroke="#4B48EC"
                strokeWidth="2"
                points={data
                  .map((_, i) => {
                    const x = 50 + i * 60;
                    const y = 170 - (values[i] / maxValue) * 150;
                    return `${x},${y}`;
                  })
                  .join(' ')}
              />
              {data.map((_, i) => {
                const x = 50 + i * 60;
                const y = 170 - (values[i] / maxValue) * 150;
                return (
                  <g key={i}>
                    <circle cx={x} cy={y} r={3} fill="#4B48EC" />
                    <text x={x} y="185" textAnchor="middle" fontSize="8" fill="#6B7280">
                      {labels[i].substring(0, 8)}
                    </text>
                  </g>
                );
              })}
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
