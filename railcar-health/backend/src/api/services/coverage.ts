/**
 * Coverage gaps along the line: stretches longer than the configured maximum
 * spacing with no working detector. Offline detectors still cover (their data
 * is buffered and will arrive); silent ones do not.
 * @module api/services/coverage
 */
export interface CoveragePoint {
  id: string
  milepost: number
  status: string
}

export interface CoverageGap {
  fromMp: number
  toMp: number
  miles: number
  causes: string[]
}

export function coverageGaps(detectors: CoveragePoint[], lineStart: number, lineEnd: number, maxSpacing: number): CoverageGap[] {
  const sorted = [...detectors].sort((a, b) => a.milepost - b.milepost)
  const covering = sorted.filter((d) => d.status !== 'silent')
  const points = [lineStart, ...covering.map((d) => d.milepost), lineEnd]
  const gaps: CoverageGap[] = []
  for (let i = 1; i < points.length; i++) {
    const miles = points[i] - points[i - 1]
    if (miles > maxSpacing) {
      const causes = sorted.filter((d) => d.status === 'silent' && d.milepost > points[i - 1] && d.milepost < points[i]).map((d) => d.id)
      if (causes.length > 0) gaps.push({ fromMp: points[i - 1], toMp: points[i], miles, causes })
    }
  }
  return gaps
}
