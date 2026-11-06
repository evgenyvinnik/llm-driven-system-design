import type { Envelope } from '@/types'

/** One line per event for the timeline. */
export function summarize(e: Envelope): string {
  const p = e.payload as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (e.type) {
    case 'HazardDetected':
      return `${p.kind} ${p.detectionStatus} at ${p.severity}, confidence ${p.confidence} from ${p.evidence?.length} evidence (${(p.evidence ?? []).map((x: { sensorId: string }) => x.sensorId).join(', ')})${p.late ? ', LATE' : ''}`
    case 'HazardEvidenceAdded':
      return `+ ${p.evidence?.sensorId} ${p.evidence?.kind}${p.evidence?.late ? ' (late)' : ''}; confidence now ${p.confidence}`
    case 'HazardUpgraded':
    case 'HazardDowngraded':
      return p.fromSeverity === p.toSeverity && p.fromStatus === p.toStatus
        ? `confidence now ${p.confidence}: ${p.reason}`
        : `${p.fromSeverity} → ${p.toSeverity} (${p.fromStatus} → ${p.toStatus}), confidence ${p.confidence}: ${p.reason}`
    case 'HazardRiskElevated':
      return `band ${p.band}: rail ${p.railTempF}°F, projected ${p.projectedTempF}°F (RNT ${p.neutralTempF}°F, ${p.slopeFPerMin}°F/min) at ${p.sensorId}`
    case 'HazardRiskSubsided':
      return `rail ${p.railTempF}°F, back below the watch band`
    case 'AlertIssued':
      return `${p.alertId} ${p.severity} to ${p.assignee ?? p.deskId}; ack by ${new Date(p.ackDeadlineAt).toLocaleTimeString()}`
    case 'AlertEscalated':
      return `${p.reason === 'ack_overdue' ? `ack overdue, escalated to level ${p.level}: ${p.target}` : `severity raised to ${p.severity}; re-acknowledge`}`
    case 'AlertAcknowledged':
      return `acknowledged by ${p.by}`
    case 'TrainsWarned':
      return `${p.automatic ? 'automatic' : `by ${p.by}`}: ${(p.trains ?? []).map((t: { symbol: string; etaMinutes: number }) => `${t.symbol} (ETA ${t.etaMinutes} min)`).join(', ')}`
    case 'TrainsReleased':
      return `released ${(p.trainIds ?? []).join(', ')}: ${p.reason}`
    case 'SpeedRestrictionIssued':
      return `${p.restrictionId} ${p.maxSpeedMph} mph MP ${p.mpFrom}–${p.mpTo} (${p.automatic ? 'automatic' : p.by})`
    case 'SpeedRestrictionLifted':
      return `${p.restrictionId} lifted by ${p.by}: ${p.reason}`
    case 'InspectorDispatched':
      return `${p.inspectorName} dispatched by ${p.by}, ETA ${p.etaMinutes} min`
    case 'HazardCleared':
      return `cleared by ${p.by}${p.note ? `: ${p.note}` : ''}`
    case 'HazardConfirmedFalseAlarm':
      return `false alarm per ${p.by}${p.note ? `: ${p.note}` : ''}`
    default:
      return JSON.stringify(p).slice(0, 140)
  }
}
