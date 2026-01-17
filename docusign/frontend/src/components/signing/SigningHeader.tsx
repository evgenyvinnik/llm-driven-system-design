/**
 * Signing page header component.
 * Displays envelope title, progress, and action buttons.
 *
 * @param props - Component props
 * @returns The signing page header
 */
interface SigningHeaderProps {
  /** Envelope name */
  envelopeName: string;
  /** Recipient name */
  recipientName: string;
  /** Number of completed fields */
  completedCount: number;
  /** Total number of required fields */
  totalRequiredCount: number;
  /** Handler for decline button */
  onDecline: () => void;
  /** Handler for finish button */
  onFinish: () => void;
}

export function SigningHeader({
  envelopeName,
  recipientName,
  completedCount,
  totalRequiredCount,
  onDecline,
  onFinish,
}: SigningHeaderProps) {
  return (
    <header className="bg-white shadow-sm">
      <div className="max-w-7xl mx-auto px-4 py-4">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{envelopeName}</h1>
            <p className="text-sm text-gray-500">
              Please review and sign - {recipientName}
            </p>
          </div>
          <div className="flex items-center space-x-4">
            <ProgressIndicator
              completed={completedCount}
              total={totalRequiredCount}
            />
            <button
              onClick={onDecline}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Decline
            </button>
            <button
              onClick={onFinish}
              className="px-4 py-2 bg-docusign-blue text-white rounded-lg font-medium hover:bg-docusign-dark"
            >
              Finish
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

/**
 * Progress indicator showing completed fields.
 */
interface ProgressIndicatorProps {
  completed: number;
  total: number;
}

function ProgressIndicator({ completed, total }: ProgressIndicatorProps) {
  return (
    <span className="text-sm text-gray-600">
      {completed}/{total} fields completed
    </span>
  );
}
