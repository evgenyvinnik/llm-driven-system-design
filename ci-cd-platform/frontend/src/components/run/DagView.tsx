import { useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { layoutDag } from '@/lib/dag'
import { statusColor } from '@/lib/status-color'
import type { RunJob } from '@/types'

const NODE_W = 190
const NODE_H = 56
const GAP_X = 56
const GAP_Y = 14
const PAD = 10

const STATUS_TEXT: Record<string, string> = { needs_attention: 'needs attention', waiting: 'waiting for approval' }

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function DagView({ runId, jobs }: { runId: string; jobs: RunJob[] }) {
  const navigate = useNavigate()
  const layout = useMemo(() => layoutDag(jobs), [jobs])
  const x = (column: number) => PAD + column * (NODE_W + GAP_X)
  const y = (row: number) => PAD + row * (NODE_H + GAP_Y)
  const width = PAD * 2 + layout.columns * NODE_W + Math.max(0, layout.columns - 1) * GAP_X
  const height = PAD * 2 + layout.rows * NODE_H + Math.max(0, layout.rows - 1) * GAP_Y

  return (
    <div className="overflow-x-auto p-3">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Job graph">
        {jobs.flatMap((job) =>
          job.needs.map((need) => {
            const from = layout.nodes.get(need)
            const to = layout.nodes.get(job.key)
            if (!from || !to) return null
            const x1 = x(from.column) + NODE_W
            const y1 = y(from.row) + NODE_H / 2
            const x2 = x(to.column)
            const y2 = y(to.row) + NODE_H / 2
            const mid = (x1 + x2) / 2
            return <path key={`${need}-${job.key}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} fill="none" stroke="#94a3b8" strokeWidth={1.5} />
          }),
        )}
        {jobs.map((job) => {
          const node = layout.nodes.get(job.key)
          if (!node) return null
          const color = statusColor(job.status)
          const open = () => void navigate({ to: '/runs/$runId/jobs/$jobId', params: { runId, jobId: job.id } })
          return (
            <g
              key={job.key}
              transform={`translate(${x(node.column)},${y(node.row)})`}
              role="link"
              tabIndex={0}
              aria-label={`${job.name}: ${job.status}, attempt ${job.attempt}`}
              className="cursor-pointer outline-none focus-visible:opacity-70"
              onClick={open}
              onKeyDown={(e) => {
                if (e.key === 'Enter') open()
              }}
            >
              <rect width={NODE_W} height={NODE_H} rx={8} fill={color.fill} stroke={color.stroke} strokeWidth={job.status === 'needs_attention' ? 2.5 : 1.5} strokeDasharray={job.status === 'skipped' || job.status === 'blocked' ? '4 3' : undefined} />
              <text x={12} y={23} fontSize={13} fontWeight={600} fill="#0f172a">
                {truncate(job.name, 24)}
              </text>
              <text x={12} y={42} fontSize={11} fill={color.text}>
                {STATUS_TEXT[job.status] ?? job.status}
                {job.attempt > 1 ? ` · attempt ${job.attempt}` : ''}
              </text>
              <title>{job.statusReason ?? job.name}</title>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
