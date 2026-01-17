/**
 * Audit trail tab component for displaying envelope audit events.
 * Shows chronological list of all events with hash chain verification status.
 *
 * @param props - Component props
 * @param props.events - Array of audit events
 * @param props.verified - Whether the hash chain was verified successfully
 * @returns The audit trail display
 */
import { AuditEvent } from '../../types';

interface AuditTabProps {
  /** Array of audit events to display */
  events: AuditEvent[];
  /** Hash chain verification result (null if not yet checked) */
  verified: boolean | null;
}

export function AuditTab({ events, verified }: AuditTabProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <AuditHeader verified={verified} />

      {events.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No audit events yet.</p>
      ) : (
        <div className="space-y-3">
          {events.map((event) => (
            <AuditEventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Header section with title and verification badge.
 */
interface AuditHeaderProps {
  verified: boolean | null;
}

function AuditHeader({ verified }: AuditHeaderProps) {
  return (
    <div className="flex justify-between items-center mb-4">
      <h2 className="text-lg font-semibold">Audit Trail</h2>
      {verified !== null && <VerificationBadge verified={verified} />}
    </div>
  );
}

/**
 * Badge showing verification status.
 */
interface VerificationBadgeProps {
  verified: boolean;
}

function VerificationBadge({ verified }: VerificationBadgeProps) {
  const colorClass = verified
    ? 'bg-green-100 text-green-800'
    : 'bg-red-100 text-red-800';
  const text = verified ? 'Chain Verified' : 'Chain Invalid';

  return (
    <span className={`px-3 py-1 rounded-full text-sm font-medium ${colorClass}`}>
      {text}
    </span>
  );
}

/**
 * Individual audit event row component.
 */
interface AuditEventRowProps {
  event: AuditEvent;
}

function AuditEventRow({ event }: AuditEventRowProps) {
  const formattedTime = new Date(event.timestamp).toLocaleString();
  const truncatedHash = `${event.hash.substring(0, 16)}...`;

  return (
    <div className="flex items-start space-x-4 p-4 border rounded-lg">
      <div className="w-2 h-2 mt-2 bg-docusign-blue rounded-full" />
      <div className="flex-1">
        <div className="flex justify-between">
          <span className="font-medium">{event.details || event.event_type}</span>
          <span className="text-sm text-gray-500">{formattedTime}</span>
        </div>
        <div className="text-sm text-gray-500">Actor: {event.actor}</div>
        <div className="text-xs text-gray-400 font-mono truncate mt-1">
          Hash: {truncatedHash}
        </div>
      </div>
    </div>
  );
}
