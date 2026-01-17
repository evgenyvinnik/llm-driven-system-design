/**
 * @fileoverview Dashboard grid layout component.
 *
 * Renders panels in a CSS grid based on their position configuration.
 * Handles panel positioning, sizing, and sorting for proper visual layout.
 */

import type { Panel } from '../types';
import { TimeRange } from '../types';
import { DashboardPanel } from './DashboardPanel';

/**
 * Props for the DashboardGrid component.
 */
interface DashboardGridProps {
  /** Array of panels to render */
  panels: Panel[];
  /** ID of the parent dashboard */
  dashboardId: string;
  /** Selected time range for panel data queries */
  timeRange: TimeRange;
  /** Number of grid columns (default: 12) */
  columns?: number;
}

/**
 * Renders a responsive grid of dashboard panels.
 *
 * Uses CSS Grid for layout with configurable column count. Panels are
 * positioned based on their x, y, width, and height properties. Panels
 * are sorted by row then column for consistent rendering order.
 *
 * @param props - Component props
 * @returns The rendered grid of panels
 */
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
