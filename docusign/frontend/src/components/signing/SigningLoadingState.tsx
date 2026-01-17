/**
 * Loading state component for the signing page.
 * Displays a centered spinner with loading message.
 *
 * @returns The signing loading state
 */
import { LoadingSpinner } from '../common/LoadingSpinner';

export function SigningLoadingState() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="text-center">
        <LoadingSpinner size="lg" />
        <p className="text-gray-600 mt-4">Loading document...</p>
      </div>
    </div>
  );
}
