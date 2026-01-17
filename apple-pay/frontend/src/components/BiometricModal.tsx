/**
 * BiometricModal component simulates biometric authentication.
 * Displays Face ID, Touch ID, or passcode authentication UI.
 * In a real implementation, this would trigger native device APIs.
 */
import { useState } from 'react';

/**
 * Props for the BiometricModal component.
 */
interface BiometricModalProps {
  /** Whether the modal is visible */
  isOpen: boolean;
  /** Type of biometric authentication to display */
  authType: 'face_id' | 'touch_id' | 'passcode';
  /** Callback when authentication succeeds */
  onSuccess: () => void;
  /** Callback when user cancels authentication */
  onCancel: () => void;
  /** Whether authentication is in progress */
  isLoading?: boolean;
}

/**
 * Renders a modal dialog for biometric authentication simulation.
 * Shows appropriate UI for Face ID, Touch ID, or passcode entry.
 * Includes a "Simulate Success" button for demo purposes.
 *
 * @param props - BiometricModal component props
 * @returns JSX element representing the biometric auth modal, or null if not open
 */
export function BiometricModal({
  isOpen,
  authType,
  onSuccess,
  onCancel,
  isLoading,
}: BiometricModalProps) {
  const [showSuccess, setShowSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSimulate = () => {
    setShowSuccess(true);
    setTimeout(() => {
      setShowSuccess(false);
      onSuccess();
    }, 1000);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-3xl w-full max-w-sm p-8 text-center">
        {showSuccess ? (
          <>
            <div className="w-24 h-24 mx-auto mb-6 text-apple-green">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-apple-gray-900 mb-2">
              Authenticated
            </h3>
          </>
        ) : authType === 'face_id' ? (
          <>
            <div className="w-24 h-24 mx-auto mb-6 face-id-scanning">
              <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="2">
                {/* Face outline */}
                <circle cx="50" cy="50" r="35" />
                {/* Eyes */}
                <circle cx="38" cy="42" r="3" fill="currentColor" />
                <circle cx="62" cy="42" r="3" fill="currentColor" />
                {/* Nose */}
                <path d="M50 48 L50 56" />
                {/* Mouth */}
                <path d="M40 62 Q50 68 60 62" />
                {/* Scan lines */}
                <line x1="10" y1="20" x2="30" y2="20" className="text-apple-blue" />
                <line x1="10" y1="20" x2="10" y2="40" className="text-apple-blue" />
                <line x1="70" y1="20" x2="90" y2="20" className="text-apple-blue" />
                <line x1="90" y1="20" x2="90" y2="40" className="text-apple-blue" />
                <line x1="10" y1="80" x2="30" y2="80" className="text-apple-blue" />
                <line x1="10" y1="60" x2="10" y2="80" className="text-apple-blue" />
                <line x1="70" y1="80" x2="90" y2="80" className="text-apple-blue" />
                <line x1="90" y1="60" x2="90" y2="80" className="text-apple-blue" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-apple-gray-900 mb-2">
              Face ID
            </h3>
            <p className="text-apple-gray-500 mb-6">
              Look at your device to authenticate
            </p>
          </>
        ) : authType === 'touch_id' ? (
          <>
            <div className="w-24 h-24 mx-auto mb-6 text-apple-gray-400">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.81 4.47c-.08 0-.16-.02-.23-.06C15.66 3.42 14 3 12 3c-2 0-3.66.42-5.58 1.41-.22.11-.48.02-.59-.2s-.02-.48.2-.59C8.16 2.48 10 2 12 2c2 0 3.84.48 5.97 1.62.21.11.31.38.2.59-.08.15-.24.26-.36.26zM3.28 7.43c-.08 0-.16-.02-.23-.06-.21-.11-.31-.38-.2-.59.74-1.41 1.71-2.59 2.88-3.51.16-.13.41-.11.55.05.13.16.11.41-.05.55-1.08.87-1.99 1.95-2.7 3.3-.08.16-.25.26-.25.26zM8.45 6.37c-.03 0-.07-.01-.1-.02-.22-.08-.35-.31-.27-.53.44-1.28 1.23-2.36 2.3-3.13.17-.13.42-.09.55.08.13.17.09.42-.08.55-.96.69-1.67 1.66-2.06 2.79-.06.18-.23.26-.34.26zM21 12c0 4.97-4.03 9-9 9-1.36 0-2.65-.3-3.81-.85-.22-.1-.32-.37-.22-.59.1-.22.37-.32.59-.22 1.04.49 2.18.75 3.36.75 4.41 0 8-3.59 8-8 0-1.18-.26-2.32-.75-3.36-.1-.22 0-.49.22-.59.22-.1.49 0 .59.22.59 1.16.89 2.45.89 3.81zM14.29 5.55c-.03 0-.07-.01-.1-.02-.22-.08-.34-.31-.27-.53.22-.66.34-1.36.34-2.08 0-.22.18-.4.4-.4s.4.18.4.4c0 .8-.14 1.58-.38 2.31-.07.2-.24.32-.39.32zM12 21c-4.97 0-9-4.03-9-9 0-1.36.3-2.65.85-3.81.1-.22.37-.32.59-.22.22.1.32.37.22.59C4.17 9.6 3.92 10.74 3.92 12c0 4.41 3.59 8 8 8 1.18 0 2.32-.26 3.36-.75.22-.1.49 0 .59.22s0 .49-.22.59c-1.09.55-2.38.85-3.65.94z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-apple-gray-900 mb-2">
              Touch ID
            </h3>
            <p className="text-apple-gray-500 mb-6">
              Place your finger on the sensor
            </p>
          </>
        ) : (
          <>
            <div className="w-24 h-24 mx-auto mb-6 text-apple-gray-400 flex items-center justify-center">
              <span className="text-4xl">****</span>
            </div>
            <h3 className="text-xl font-semibold text-apple-gray-900 mb-2">
              Enter Passcode
            </h3>
            <p className="text-apple-gray-500 mb-6">
              Enter your device passcode
            </p>
          </>
        )}

        {!showSuccess && (
          <div className="space-y-3">
            <button
              onClick={handleSimulate}
              disabled={isLoading}
              className="btn-primary w-full"
            >
              {isLoading ? 'Authenticating...' : 'Simulate Success'}
            </button>
            <button
              onClick={onCancel}
              className="btn-secondary w-full"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
