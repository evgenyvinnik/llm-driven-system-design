/**
 * Recipients tab component for managing envelope recipients.
 * Allows adding new recipients and viewing/deleting existing ones.
 *
 * @param props - Component props
 * @returns The recipients management tab content
 */
import { Recipient } from '../../types';
import { StatusBadge } from '../common/StatusBadge';

interface RecipientsTabProps {
  /** Array of recipients in the envelope */
  recipients: Recipient[];
  /** Whether the envelope is in draft status (allows editing) */
  isDraft: boolean;
  /** Current value of the name input */
  newName: string;
  /** Current value of the email input */
  newEmail: string;
  /** Handler for name input change */
  onNameChange: (value: string) => void;
  /** Handler for email input change */
  onEmailChange: (value: string) => void;
  /** Handler for form submission */
  onAdd: (e: React.FormEvent) => void;
  /** Handler for recipient deletion */
  onDelete: (id: string) => void;
}

export function RecipientsTab({
  recipients,
  isDraft,
  newName,
  newEmail,
  onNameChange,
  onEmailChange,
  onAdd,
  onDelete,
}: RecipientsTabProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Recipients</h2>

      {isDraft && (
        <AddRecipientForm
          name={newName}
          email={newEmail}
          onNameChange={onNameChange}
          onEmailChange={onEmailChange}
          onSubmit={onAdd}
        />
      )}

      {recipients.length === 0 ? (
        <p className="text-gray-500 text-center py-8">
          No recipients added yet.
        </p>
      ) : (
        <div className="space-y-3">
          {recipients.map((recipient, index) => (
            <RecipientRow
              key={recipient.id}
              recipient={recipient}
              order={index + 1}
              isDraft={isDraft}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Form for adding a new recipient.
 */
interface AddRecipientFormProps {
  name: string;
  email: string;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

function AddRecipientForm({
  name,
  email,
  onNameChange,
  onEmailChange,
  onSubmit,
}: AddRecipientFormProps) {
  return (
    <form onSubmit={onSubmit} className="flex space-x-4 mb-6">
      <input
        type="text"
        placeholder="Name"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        className="flex-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-docusign-blue"
        required
      />
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        className="flex-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-docusign-blue"
        required
      />
      <button
        type="submit"
        className="bg-docusign-blue text-white px-4 py-2 rounded-lg font-medium hover:bg-docusign-dark"
      >
        Add Recipient
      </button>
    </form>
  );
}

/**
 * Individual recipient row component.
 */
interface RecipientRowProps {
  recipient: Recipient;
  order: number;
  isDraft: boolean;
  onDelete: (id: string) => void;
}

function RecipientRow({ recipient, order, isDraft, onDelete }: RecipientRowProps) {
  return (
    <div className="flex items-center justify-between p-4 border rounded-lg">
      <div className="flex items-center space-x-4">
        <div className="w-8 h-8 bg-docusign-blue text-white rounded-full flex items-center justify-center font-medium">
          {order}
        </div>
        <div>
          <div className="font-medium">{recipient.name}</div>
          <div className="text-sm text-gray-500">{recipient.email}</div>
        </div>
        <StatusBadge status={recipient.status} />
      </div>
      {isDraft && (
        <button
          onClick={() => onDelete(recipient.id)}
          className="text-red-600 hover:text-red-900 text-sm"
        >
          Remove
        </button>
      )}
    </div>
  );
}
