/**
 * @fileoverview Dashboard panel wrapper component.
 *
 * Provides a consistent card layout for all panel types and delegates
 * rendering to the appropriate visualization component based on panel_type.
 */

import type { Panel } from '../types';
import { TimeRange } from '../types';
import { PanelChart } from './PanelChart';
import { StatPanel } from './StatPanel';
import { GaugePanel } from './GaugePanel';

/**
 * Props for the DashboardPanel component.
 */
interface DashboardPanelProps {
  /** The panel configuration */
  panel: Panel;
  /** ID of the parent dashboard */
  dashboardId: string;
  /** Selected time range for data queries */
  timeRange: TimeRange;
}

/**
 * Renders a dashboard panel with header and appropriate visualization.
 *
 * This component serves as a router that selects the correct visualization
 * component (chart, stat, gauge, table) based on the panel's type property.
 * All panels share a consistent card layout with title and metric name.
 *
 * @param props - Component props
 * @returns The rendered panel card with visualization
 */
export function DashboardPanel({ panel, dashboardId, timeRange }: DashboardPanelProps) {
  const renderContent = () => {
    switch (panel.panel_type) {
      case 'line_chart':
      case 'area_chart':
      case 'bar_chart':
        return (
          <PanelChart
            panel={panel}
            dashboardId={dashboardId}
            timeRange={timeRange}
          />
        );
      case 'stat':
        return (
          <StatPanel
            panel={panel}
            dashboardId={dashboardId}
            timeRange={timeRange}
          />
        );
      case 'gauge':
        return (
          <GaugePanel
            panel={panel}
            dashboardId={dashboardId}
            timeRange={timeRange}
          />
        );
      case 'table':
        return (
          <div className="h-full flex items-center justify-center text-dashboard-muted">
            Table view not implemented yet
          </div>
        );
      default:
        return (
          <div className="h-full flex items-center justify-center text-dashboard-muted">
            Unknown panel type
          </div>
        );
    }
  };

  return (
    <div className="bg-dashboard-card rounded-lg border border-dashboard-accent overflow-hidden h-full flex flex-col">
      <div className="px-4 py-2 border-b border-dashboard-accent flex items-center justify-between">
        <h3 className="text-sm font-medium text-dashboard-text truncate">
          {panel.title}
        </h3>
        <span className="text-xs text-dashboard-muted">
          {panel.query.metric_name}
        </span>
      </div>
      <div className="flex-1 p-2 min-h-0">{renderContent()}</div>
    </div>
  );
}
