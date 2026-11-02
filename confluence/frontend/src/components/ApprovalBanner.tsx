import { useState, useEffect } from 'react';
import * as api from '../services/api';
import type { Approval } from '../types';
import { useAuthStore } from '../stores/authStore';
import { formatDate } from '../utils/format';

interface ApprovalBannerProps {
  pageId: string;
  /** Whether the user can edit the page (and so request a review of it). */
  canEdit: boolean;
}

/** Displays pending approval status with approve/reject actions and approval history. */
export default function ApprovalBanner({ pageId, canEdit }: ApprovalBannerProps) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [canReview, setCanReview] = useState(false);
  const { user } = useAuthStore();

  useEffect(() => {
    let cancelled = false;
    api.getPageApprovals(pageId).then(({ approvals: a, canReview: r }) => {
      if (cancelled) return;
      setApprovals(a);
      setCanReview(r);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const pendingApproval = approvals.find((a) => a.status === 'pending');

  const handleRequestApproval = async () => {
    try {
      const { approval } = await api.requestApproval(pageId);
      setApprovals([approval, ...approvals]);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to request approval');
    }
  };

  const handleReview = async (approvalId: string, status: 'approved' | 'rejected') => {
    const comment = prompt(`${status === 'approved' ? 'Approval' : 'Rejection'} comment (optional):`);
    // Cancel means "don't review", not "review with no comment".
    if (comment === null) return;
    try {
      const { approval } = await api.reviewApproval(approvalId, status, comment || undefined);
      setApprovals(approvals.map((a) => (a.id === approvalId ? approval : a)));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to review approval');
    }
  };

  if (!user) return null;

  return (
    <div>
      {/* Pending approval banner */}
      {pendingApproval && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-yellow-800">
                Pending Approval
              </span>
              <span className="text-xs text-yellow-600 ml-2">
                Requested by {pendingApproval.requester_username} {formatDate(pendingApproval.created_at)}
              </span>
            </div>
            {canReview && pendingApproval.requested_by !== user.id && (
              <div className="flex gap-2">
                <button
                  onClick={() => handleReview(pendingApproval.id, 'approved')}
                  className="px-3 py-1 text-xs bg-confluence-success text-white rounded hover:opacity-90"
                >
                  Approve
                </button>
                <button
                  onClick={() => handleReview(pendingApproval.id, 'rejected')}
                  className="px-3 py-1 text-xs bg-confluence-danger text-white rounded hover:opacity-90"
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Request approval button (if no pending) */}
      {!pendingApproval && canEdit && (
        <button
          onClick={handleRequestApproval}
          className="mb-4 text-xs text-confluence-text-subtle hover:text-confluence-primary transition-colors"
        >
          Request Approval
        </button>
      )}

      {/* Recent approvals */}
      {approvals.filter((a) => a.status !== 'pending').length > 0 && (
        <div className="mb-4">
          {approvals
            .filter((a) => a.status !== 'pending')
            .slice(0, 3)
            .map((approval) => (
              <div
                key={approval.id}
                className={`text-xs px-3 py-1.5 rounded mb-1 ${
                  approval.status === 'approved'
                    ? 'bg-green-50 text-green-700'
                    : 'bg-red-50 text-red-700'
                }`}
              >
                {approval.status === 'approved' ? 'Approved' : 'Rejected'} by{' '}
                {approval.reviewer_username} {approval.reviewed_at ? formatDate(approval.reviewed_at) : ''}
                {approval.comment && ` - "${approval.comment}"`}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
