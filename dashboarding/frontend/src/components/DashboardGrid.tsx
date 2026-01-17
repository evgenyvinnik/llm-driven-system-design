import type { Panel } from '../types';
import { TimeRange } from '../types';
import { DashboardPanel } from './DashboardPanel';

interface DashboardGridProps {
  panels: Panel[];
  dashboardId: string;
  timeRange: TimeRange;
  columns?: number;
}

export function DashboardGrid({
  panels,
  dashboardId,
  timeRange,
  columns = 12,
}: DashboardGridProps) {
  // Calculate grid layout
  const cellHeight = 120; // Base height per grid unit

  // Sort panels by position
  const sortedPanels = [...panels].sort((a, b) => {
    if (a.position.y !== b.position.y) return a.position.y - b.position.y;
    return a.position.x - b.position.x;
  });

  return (
    <div
      className="grid gap-4 p-4"
      style={{
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
      }}
    >
      {sortedPanels.map((panel) => (
        <div
          key={panel.id}
          style={{
            gridColumn: `${panel.position.x + 1} / span ${panel.position.width}`,
            gridRow: `${panel.position.y + 1} / span ${panel.position.height}`,
            height: `${panel.position.height * cellHeight}px`,
          }}
        >
          <DashboardPanel
            panel={panel}
            dashboardId={dashboardId}
            timeRange={timeRange}
          />
        </div>
      ))}
    </div>
  );
}
