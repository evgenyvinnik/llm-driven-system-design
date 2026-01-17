/**
 * ErrorState - An error message display component.
 * Used to show error messages in a styled container.
 *
 * @param message - The error message to display
 */
interface ErrorStateProps {
  message: string;
}

export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
      <p className="text-red-600">{message}</p>
    </div>
  );
}
