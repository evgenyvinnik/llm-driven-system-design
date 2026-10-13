/**
 * "How you're connected" line: the shortest chain from the viewer to a 2nd- or
 * 3rd-degree member, as computed by the backend's bidirectional search.
 *
 * @module components/profile/ConnectionPath
 */
import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';
import type { Relationship } from '../../types';

interface ConnectionPathProps {
  relationship: Relationship | null;
}

/**
 * Renders "You → Bob Williams → Ethan Brooks" plus the mutual count.
 *
 * @param props - Component props
 * @returns The path line, or nothing for 1st degree / out of network
 */
export function ConnectionPath({ relationship }: ConnectionPathProps) {
  if (!relationship || relationship.path.length < 3) {
    return relationship?.degree === null && relationship.status !== 'self' ? (
      <p className="mt-2 text-sm text-gray-500">Outside your network (beyond 3rd degree)</p>
    ) : null;
  }

  const [, ...rest] = relationship.path;
  return (
    <div className="mt-2 text-sm text-gray-600">
      <span className="font-medium">How you're connected: </span>
      <span>You</span>
      {rest.map((member) => (
        <Fragment key={member.id}>
          <span aria-hidden="true"> &rarr; </span>
          <span className="sr-only">, then </span>
          <Link
            to="/profile/$userId"
            params={{ userId: String(member.id) }}
            className="text-linkedin-blue hover:underline"
          >
            {member.first_name} {member.last_name}
          </Link>
        </Fragment>
      ))}
      {relationship.mutual_count > 0 && (
        <span className="ml-2 text-gray-500">
          ({relationship.mutual_count} mutual connection{relationship.mutual_count > 1 ? 's' : ''})
        </span>
      )}
    </div>
  );
}
