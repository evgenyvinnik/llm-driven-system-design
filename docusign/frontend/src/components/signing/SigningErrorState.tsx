/**
 * Error state component for the signing page.
 * Displays when the document cannot be loaded.
 *
 * @param props - Component props
 * @param props.error - Error message to display
 * @returns The signing error state
 */
import { WarningIcon } from '../icons/WarningIcon';

interface SigningErrorStateProps {
  /** Error message to display */
  error: string;
}

export function SigningErrorState({ error }: SigningErrorStateProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-lg text-center max-w-md">
        <WarningIcon className="w-16 h-16 text-red-500 mx-auto mb-4" />
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          Unable to Load Document
        </h1>
        <p className="text-gray-600">{error}</p>
      </div>
    </div>
  );
}
