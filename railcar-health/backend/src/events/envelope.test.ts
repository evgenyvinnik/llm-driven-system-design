import { describe, expect, it } from 'vitest'
import { validatePayload } from './catalog.js'
import { toEnvelope, upcast, UnknownSchemaVersionError, type StoredEventRow } from './envelope.js'

const v1Finding = {
  caseId: '11111111-1111-4111-8111-111111111111', findingId: '22222222-2222-4222-8222-222222222222', workOrderId: '33333333-3333-4333-8333-333333333333',
  clientSubmissionId: 'tablet-1', carId: 'NRLX 1', position: 'R3', finding: 'confirmed_bearing_defect', disposition: 'bad_order', notes: null,
  recordedBy: 'bob', observedAt: '2026-10-01T10:00:00.000Z', replacement: null,
}

describe('schema evolution: InspectionFindingRecorded v1 -> v2', () => {
  it('upcasts a v1 finding with an alert to source "alert" and validates against v2', () => {
    const out = upcast('InspectionFindingRecorded', 1, { ...v1Finding, alertId: v1Finding.caseId })
    expect(out.version).toBe(2)
    expect(out.payload).toMatchObject({ source: 'alert', supersedesFindingId: null })
    expect(out.payload).not.toHaveProperty('alertId')
    expect(() => validatePayload('InspectionFindingRecorded', 2, out.payload)).not.toThrow()
  })

  it('upcasts a v1 finding without an alert to source "audit" (v1 could not say routine or teardown)', () => {
    expect(upcast('InspectionFindingRecorded', 1, { ...v1Finding, alertId: null }).payload.source).toBe('audit')
  })

  it('leaves a v2 payload as it is', () => {
    const v2 = { ...v1Finding, source: 'teardown', supersedesFindingId: null }
    expect(upcast('InspectionFindingRecorded', 2, v2)).toEqual({ version: 2, payload: v2 })
  })

  it('refuses a version newer than this code knows: a permanent error for the dead-letter stream', () => {
    expect(() => upcast('InspectionFindingRecorded', 3, v1Finding)).toThrow(UnknownSchemaVersionError)
    expect(() => upcast('NoSuchEvent', 1, {})).toThrow(UnknownSchemaVersionError)
  })

  it('keeps the stored version on the envelope so timelines can show "v1 -> v2"', () => {
    const row: StoredEventRow = {
      global_position: '42', event_id: 'e1', stream_id: `case-${v1Finding.caseId}`, stream_type: 'case', stream_version: 5, type: 'InspectionFindingRecorded',
      version: 1, family: 'cases', partition_key: v1Finding.caseId, occurred_at: new Date('2026-10-01T10:00:00Z'), recorded_at: '2026-10-01T10:05:00Z',
      committed_at: new Date(), correlation_id: 'finding:tablet-1', causation_id: null, actor: 'bob', tags: ['car:NRLX 1'], payload: { ...v1Finding, alertId: null },
    }
    const e = toEnvelope(row)
    expect(e).toMatchObject({ version: 2, storedVersion: 1, globalPosition: 42, streamVersion: 5, occurredAt: '2026-10-01T10:00:00.000Z', recordedAt: '2026-10-01T10:05:00.000Z' })
    expect(e.payload.source).toBe('audit')
  })
})
