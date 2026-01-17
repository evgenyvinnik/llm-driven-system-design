/**
 * CreateRequestForm component for creating money requests.
 * Allows users to search for a recipient, enter an amount, and add a note.
 */

import { useState } from 'react';
import { api } from '../../services/api';
import { Button } from '../Button';
import { TextArea } from '../Input';
import { UserSearchDropdown, SelectedUserCard } from './UserSearchDropdown';
import { AmountInput } from './AmountInput';
import type { UserSearchResult } from './UserSearchDropdown';

/**
 * Props for the CreateRequestForm component.
 */
interface CreateRequestFormProps {
  /** Callback when request is successfully created */
  onSuccess: () => void;
}

/**
 * Renders a form for creating a new payment request.
 * Users can search for a recipient, specify an amount, and add a note.
 */
export function CreateRequestForm({ onSuccess }: CreateRequestFormProps) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(null);

  /**
   * Handles selection of a user from the search dropdown.
   */
  const handleUserSelect = (user: UserSearchResult) => {
    setSelectedUser(user);
    setRecipient(user.username);
  };

  /**
   * Handles form submission to create the request.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    setLoading(true);

    try {
      await api.createRequest({
        recipientUsername: recipient,
        amount: amountNum,
        note,
      });

      setSuccess(true);
      resetForm();
      onSuccess();

      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Resets the form to initial state.
   */
  const resetForm = () => {
    setRecipient('');
    setAmount('');
    setNote('');
    setSelectedUser(null);
  };

  return (
    <>
      <SuccessMessage show={success} />

      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-lg shadow-sm p-6 space-y-4"
      >
        <h2 className="text-lg font-semibold">Request Money</h2>

        <div className="relative">
          <UserSearchDropdown
            label="From"
            value={recipient}
            onChange={(value) => {
              setRecipient(value);
              setSelectedUser(null);
            }}
            onSelect={handleUserSelect}
            placeholder="Enter username"
            required
          />

          {selectedUser && <SelectedUserCard user={selectedUser} />}
        </div>

        <AmountInput value={amount} onChange={setAmount} required />

        <TextArea
          label="What's it for?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note..."
          rows={3}
        />

        {error && <p className="text-red-500 text-sm text-center">{error}</p>}

        <Button type="submit" className="w-full" loading={loading}>
          Request
        </Button>
      </form>
    </>
  );
}

/**
 * Props for the SuccessMessage component.
 */
interface SuccessMessageProps {
  /** Whether to show the success message */
  show: boolean;
}

/**
 * Displays a success message banner when a request is sent.
 */
function SuccessMessage({ show }: SuccessMessageProps) {
  if (!show) return null;

  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4 text-center">
      <p className="text-green-800 font-medium">Request sent!</p>
    </div>
  );
}
