import { useCallback, useEffect, useState } from 'react';
import { requestsApi } from '../services/api';
import type { TransferRequest } from '../types';
import { RequestCard } from './RequestCard';

interface OutgoingRequestsProps {
  currentUserId: string;
}

/** Requests the user has sent: pending ones can be cancelled, finished ones show their outcome. */
export function OutgoingRequests({ currentUserId }: OutgoingRequestsProps) {
  const [requests, setRequests] = useState<TransferRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await requestsApi.list('outgoing');
      setRequests(res.requests);
    } catch {
      setRequests([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-paypal-border p-6 mt-6">
      <h2 className="text-lg font-semibold text-paypal-text mb-4">Your requests</h2>
      {loading ? (
        <div className="py-4 text-center text-paypal-secondary">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="py-4 text-center text-paypal-secondary">You haven't requested money yet.</div>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => (
            <RequestCard key={req.id} request={req} currentUserId={currentUserId} onAction={load} />
          ))}
        </div>
      )}
    </div>
  );
}
