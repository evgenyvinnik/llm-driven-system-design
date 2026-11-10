/** Layout for the DAG view: longest-path columns, with rows ordered to keep edges short. */
export interface DagInput {
  key: string
  needs: string[]
}

export interface DagNode {
  key: string
  column: number
  row: number
}

export interface DagLayout {
  nodes: Map<string, DagNode>
  columns: number
  rows: number
}

export function layoutDag(jobs: DagInput[]): DagLayout {
  const needsOf = new Map(jobs.map((j) => [j.key, j.needs]))
  const memo = new Map<string, number>()
  const depth = (key: string): number => {
    const known = memo.get(key)
    if (known !== undefined) return known
    const value = (needsOf.get(key) ?? []).reduce((max, dep) => Math.max(max, depth(dep) + 1), 0)
    memo.set(key, value)
    return value
  }
  const byColumn = new Map<number, string[]>()
  for (const job of jobs) {
    const column = depth(job.key)
    byColumn.set(column, [...(byColumn.get(column) ?? []), job.key])
  }
  const nodes = new Map<string, DagNode>()
  const columns = byColumn.size === 0 ? 0 : Math.max(...byColumn.keys()) + 1
  let rows = 0
  for (let column = 0; column < columns; column++) {
    const keys = byColumn.get(column) ?? []
    // Barycenter: put a job near the average row of what it needs.
    const scored = keys.map((key) => {
      const needs = needsOf.get(key) ?? []
      const avg = needs.length > 0 ? needs.reduce((sum, n) => sum + (nodes.get(n)?.row ?? 0), 0) / needs.length : keys.indexOf(key)
      return { key, avg }
    })
    scored.sort((a, b) => a.avg - b.avg)
    scored.forEach(({ key }, row) => nodes.set(key, { key, column, row }))
    rows = Math.max(rows, keys.length)
  }
  return { nodes, columns, rows }
}
