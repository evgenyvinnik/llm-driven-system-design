import { CheckIcon } from '../icons';

/**
 * Props for SuccessView component.
 */
interface SuccessViewProps {
  /** Callback to continue shopping after order completion */
  onContinueShopping: () => void;
  /** Primary theme color */
  primaryColor: string;
}

/**
 * Order success view component.
 * Displays confirmation message after successful checkout.
 *
 * @param props - Success view configuration
 * @returns Centered success message with continue shopping button
 */
export function SuccessView({ onContinueShopping, primaryColor }: SuccessViewProps) {
  return (
    <div className="max-w-md mx-auto text-center py-12">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6"
        style={{ backgroundColor: primaryColor }}
      >
        <CheckIcon />
      </div>
      <h1 className="text-3xl font-bold text-gray-900 mb-4">Thank You!</h1>
      <p className="text-gray-600 mb-8">
        Your order has been placed successfully. You will receive a confirmation email shortly.
      </p>
      <button
        onClick={onContinueShopping}
        className="px-8 py-3 rounded-lg font-medium text-white"
        style={{ backgroundColor: primaryColor }}
      >
        Continue Shopping
      </button>
    </div>
  );
}
