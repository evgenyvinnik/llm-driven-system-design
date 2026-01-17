/**
 * @fileoverview Response form component for developer review replies.
 * Provides an expandable form for developers to respond to user reviews.
 */

import { useState } from 'react';

/**
 * Props for the ResponseForm component.
 */
interface ResponseFormProps {
  /** Callback when the response is submitted */
  onSubmit: (response: string) => void;
}

/**
 * Inline form component for developer review responses.
 * Expands from a button to a full text area when activated.
 * Provides submit and cancel actions.
 *
 * @param props - Component props
 * @returns Expandable form for writing review responses
 *
 * @example
 * ```tsx
 * <ResponseForm
 *   onSubmit={(response) => handleRespondToReview(reviewId, response)}
 * />
 * ```
 */
export function ResponseForm({ onSubmit }: ResponseFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [response, setResponse] = useState('');

  /**
   * Handles form submission.
   * Submits the response if not empty and resets the form state.
   * @param e - Form submit event
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (response.trim()) {
      onSubmit(response);
      setResponse('');
      setIsOpen(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="text-sm text-primary-600 hover:text-primary-700 mt-2"
      >
        Reply to this review
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 p-3 bg-gray-50 rounded-lg">
      <textarea
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        className="input min-h-[80px] mb-2"
        placeholder="Write your response..."
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="btn btn-secondary text-sm"
        >
          Cancel
        </button>
        <button type="submit" className="btn btn-primary text-sm">
          Submit Response
        </button>
      </div>
    </form>
  );
}
