/**
 * OverviewTab component - Dashboard statistics and recent activity.
 * Displays key metrics, shape distribution chart, and recent training jobs.
 * Uses StatCard components for the top-level statistics.
 * @module routes/admin/components/OverviewTab
 */

import { StatCard } from './StatCard'
import { type AdminStats } from '../../../services/api'

/**
 * Props for the OverviewTab component.
 */
interface OverviewTabProps {
  /** Dashboard statistics from the admin API */
  stats: AdminStats
}

/**
 * Dashboard overview tab showing key statistics and recent activity.
 * Displays stat cards for total drawings, users, flagged items, and active model.
 * Includes a shape distribution bar chart and recent training jobs list.
 *
 * @param props - Component props
 * @param props.stats - Dashboard statistics from the admin API
 */
export function OverviewTab({ stats }: OverviewTabProps) {
  /** Calculate the maximum count for scaling bar widths */
  const maxShapeCount = Math.max(...stats.drawings_per_shape.map((s) => s.count), 1)

  return (
    <div className="overview-grid">
      <StatCard
        title="Total Drawings"
        value={stats.total_drawings}
        subtitle={`${stats.today_count} today`}
        color="blue"
      />
      <StatCard
        title="Total Users"
        value={stats.total_users}
        color="green"
      />
      <StatCard
        title="Flagged"
        value={stats.flagged_count}
        color="red"
      />
      <StatCard
        title="Active Model"
        value={stats.active_model?.version || 'None'}
        subtitle={
          stats.active_model
            ? `${(stats.active_model.accuracy * 100).toFixed(1)}% accuracy`
            : 'Train a model'
        }
        color="purple"
      />

      <ShapeBreakdownCard
        shapes={stats.drawings_per_shape}
        maxCount={maxShapeCount}
      />

      <RecentJobsCard jobs={stats.recent_jobs} />
    </div>
  )
}

/**
 * Props for the ShapeBreakdownCard component.
 */
interface ShapeBreakdownCardProps {
  /** Array of shape names and their drawing counts */
  shapes: Array<{ name: string; count: number }>
  /** Maximum count for scaling bar widths */
  maxCount: number
}

/**
 * Card displaying a bar chart of drawings per shape.
 * Each shape shows a proportional bar and count.
 *
 * @param props - Component props
 * @param props.shapes - Array of shape names and counts
 * @param props.maxCount - Maximum count for bar scaling
 */
function ShapeBreakdownCard({ shapes, maxCount }: ShapeBreakdownCardProps) {
  return (
    <div className="shape-breakdown card">
      <h3>Drawings by Shape</h3>
      <div className="shape-bars">
        {shapes.map((shape) => (
          <div key={shape.name} className="shape-bar">
            <span className="shape-name">{shape.name}</span>
            <div className="bar-container">
              <div
                className="bar-fill"
                style={{
                  width: `${(shape.count / maxCount) * 100}%`,
                }}
              />
            </div>
            <span className="shape-count">{shape.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Training job entry from the admin stats.
 */
interface RecentJob {
  id: string
  status: string
  created_at: string
  completed_at: string | null
  accuracy: string | null
}

/**
 * Props for the RecentJobsCard component.
 */
interface RecentJobsCardProps {
  /** Array of recent training jobs */
  jobs: RecentJob[]
}

/**
 * Card displaying a list of recent training jobs.
 * Shows job status, date, and accuracy (if completed).
 *
 * @param props - Component props
 * @param props.jobs - Array of recent training jobs
 */
function RecentJobsCard({ jobs }: RecentJobsCardProps) {
  return (
    <div className="recent-jobs card">
      <h3>Recent Training Jobs</h3>
      <ul>
        {jobs.map((job) => (
          <li key={job.id} className={`job-${job.status}`}>
            <span className="job-status">{job.status}</span>
            <span className="job-date">
              {new Date(job.created_at).toLocaleDateString()}
            </span>
            {job.accuracy && (
              <span className="job-accuracy">{parseFloat(job.accuracy) * 100}%</span>
            )}
          </li>
        ))}
        {jobs.length === 0 && <li className="empty">No training jobs yet</li>}
      </ul>
    </div>
  )
}
