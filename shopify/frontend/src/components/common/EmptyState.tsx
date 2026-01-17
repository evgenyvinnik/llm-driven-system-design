/**
 * Empty state display component.
 * Shows a message when no data is available (e.g., empty cart, no products).
 *
 * @param props.icon - Optional React node for an icon
 * @param props.title - Main heading text
 * @param props.description - Supporting description text
 * @param props.action - Optional action button or element
 * @returns Empty state UI with icon, title, description, and optional action
 */
interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="text-center py-12">
      {icon && <div className="mb-4">{icon}</div>}
      <h2 className="text-2xl font-bold text-gray-900 mb-4">{title}</h2>
      <p className="text-gray-600 mb-6">{description}</p>
      {action}
    </div>
  );
}

/**
 * Error state display component.
 * Shows an error message with optional retry action.
 *
 * @param props.title - Error heading text
 * @param props.message - Error description
 * @param props.action - Optional retry button or link
 * @returns Error state UI
 */
interface ErrorStateProps {
  title: string;
  message: string;
  action?: React.ReactNode;
}

export function ErrorState({ title, message, action }: ErrorStateProps) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">{title}</h1>
        <p className="text-gray-600 mb-6">{message}</p>
        {action}
      </div>
    </div>
  );
}
