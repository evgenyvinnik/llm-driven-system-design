/** Node colors in the DAG view. Status always comes with a text label too, so color is never alone. */
export function statusColor(status: string): { fill: string; stroke: string; text: string } {
  switch (status) {
    case 'success':
      return { fill: '#d1fae5', stroke: '#10b981', text: '#065f46' }
    case 'failure':
      return { fill: '#ffe4e6', stroke: '#f43f5e', text: '#9f1239' }
    case 'running':
      return { fill: '#cffafe', stroke: '#0891b2', text: '#155e75' }
    case 'queued':
      return { fill: '#e0f2fe', stroke: '#0ea5e9', text: '#075985' }
    case 'waiting':
      return { fill: '#ede9fe', stroke: '#8b5cf6', text: '#5b21b6' }
    case 'needs_attention':
      return { fill: '#fde68a', stroke: '#d97706', text: '#78350f' }
    case 'cancelled':
      return { fill: '#e2e8f0', stroke: '#64748b', text: '#334155' }
    default:
      return { fill: '#f1f5f9', stroke: '#cbd5e1', text: '#64748b' }
  }
}
